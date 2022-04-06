//SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

/// Interface for the marketplace we will be buying NFTs through
interface NftMarketplace {
    function getPrice(address nftContract, uint256 nftId)
        external
        returns (uint256 price);

    function buy(address nftContract, uint256 nftId)
        external
        payable
        returns (bool success);
}

/// @title CollectorDAO
/// @author Paul Czajka [paul.czajka@gmail.com]
/// @notice A DAO for NFT collectors
contract CollectorDAO {
    /// Required 25% quorem votes for a proposal vote to be valid
    uint8 public constant QUOREM_PERCENT = 25;

    /// Period in which a proposal can be canceled by the proposer
    uint256 public constant CANCEL_PERIOD = 60 minutes;

    /// Once proposed, proposals are open for voting up to 3 days
    uint256 public constant VOTING_DURATION = 3 days;

    /// Once voting has ended, execute can be triggered for up to 3 days
    uint256 public constant EXECUTION_DURATION = 3 days;

    /// For EIP712
    string public constant NAME = "CollectorDAO";

    /// For EIP712
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256(
            "EIP712Domain(string name,uint256 chainId,address verifyingContract)"
        );

    /// For EIP712
    bytes32 public constant VOTE_TYPEHASH =
        keccak256("SigVote(uint256 proposalId,bool memberVote)");

    /// For EIP712
    bytes32 private immutable domainSeparator;

    /// For receiving ERC721
    bytes4 private constant ERC721_RECEIVER =
        bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));

    /// DAO membership: individuals who bought-in for 1 ETH
    mapping(address => bool) public members;

    /// Total number of members. Used for quorem counting
    uint256 public memberCount;

    /// The Nft Marketplace contract we're buying through
    NftMarketplace private nftMarketplace;

    /// Phases a proposal can move through
    ///  NotCreated
    ///    - Does not exist yet
    ///  Voting
    ///    - For 3 days after creation, a proposal can be voted on
    ///  ReadyForExecution
    ///    - Proposals that end votintg period with Pass
    ///    - Execution period last for 3 days, after voting ends
    ///  Executing
    ///    - A proposal execution is in progress
    ///  Closed
    ///    - A failed proposal, or one that wasn't executed
    enum ProposalStatus {
        NotCreated,
        Voting,
        ReadyForExecute,
        Executing,
        Closed
    }

    /// Structure used to track member votes on a proposal
    struct Vote {
        /// Flag whether a vote has been provided
        bool exists;
        /// Yay = true, Nay = false
        bool vote;
    }

    /// Structure defining a proposal
    struct Proposal {
        /// The creator of this proposal.
        address proposer;
        /// Hash of the proposed arbitrary function calls
        bytes32 hash;
        /// Timestamp of creation.
        /// @dev used to calculate: cancelUntil, voteUntil, executeUntil
        uint256 proposedAt;
        /// Total number of Yay/Nay votes cast
        uint256 totalVotes;
        ///  Total number of Yay
        uint256 yayVotes;
        /// Whether the proposal was canceled
        bool canceled;
        /// True during execute(). Prevents re-entrency concerns during execution
        bool executing;
        /// Whether the execution successfully finished
        bool executionCompleted;
        /// Votes made
        mapping(address => Vote) votes;
    }

    /// All proposals ever made
    mapping(uint256 => Proposal) public proposals;

    /// Track the next proposal ID to be created.
    uint256 public nextProposalId = 1;

    /// Prevent re-entrancy
    /// @dev 1 = unlocked, 2 = locked
    uint8 private locked = 1;

    /// Notify new member joined the DAO
    /// @param member Address of the new member
    event NewMember(address member);

    /// Notify when new proposal is created
    /// @param proposalId Proposal Id
    /// @param targets Contracts to call
    /// @param values Values to send
    /// @param signatures Function signatures
    /// @param calldatas Function call data
    event NewProposal(
        uint256 indexed proposalId,
        address[] targets,
        uint256[] values,
        string[] signatures,
        bytes[] calldatas
    );

    /// Proposal was canceled by the proposer
    /// @param proposalId The canceled proposal
    event ProposalCanceled(uint256 indexed proposalId);

    /// A proposal was executed
    /// @param proposalId The executed proposal
    event ProposalExecuted(uint256 indexed proposalId);

    /// A new vote was cast
    /// @param proposalId The proposal being voted on
    /// @param voter The voter
    /// @param vote Yay = true, Nay = false
    event NewVote(uint256 indexed proposalId, address voter, bool vote);

    /// onERC721Received callback
    /// @param operator The operator initiating the callback
    /// @param from Prior owner of the NFT
    /// @param tokenId The NFT token id
    /// @param data Additional data
    event NftReceived(
        address operator,
        address from,
        uint256 tokenId,
        bytes data
    );

    /// An NFT was purchased
    /// @param nftContract The purchased NFT Contract
    /// @param nftId The purchased NFT id
    /// @param proposedValue The purchase value submitted with the proposal
    /// @param purchasePrice The actual price the NFT was purchased for.
    event NftPurchaseCompleted(
        address nftContract,
        uint256 nftId,
        uint256 proposedValue,
        uint256 purchasePrice
    );

    /// Initialize the CollectorDAO
    /// @param _nftMarketplace The Nft Marketplace contract all purchases are routed to.
    constructor(address _nftMarketplace) {
        nftMarketplace = NftMarketplace(_nftMarketplace);

        uint256 chainId;
        assembly {
            chainId := chainid()
        }
        domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                chainId,
                address(this)
            )
        );
    }

    modifier onlyMembers(address member) {
        require(members[member], "NOT_MEMBER");
        _;
    }

    modifier validProposal(uint256 proposalId) {
        require(proposalId < nextProposalId, "INVALID_PROPOSAL");
        _;
    }

    /// Prevent re-entrancy in methods intended to be invoked in proposal execution
    modifier nonReentrant() {
        require(locked == 1, "NO_REENTRANCY");
        locked = 2;
        _;
        locked = 1;
    }

    /*
     * MEMBERSHIP
     */

    /// Become a member of CollectorDAO for 1 ETH
    /// If a vote is in progress, you'll need to use joinWithVote() instead
    function join() external payable {
        _join(msg.sender, msg.value);
    }

    /// Join while a vote is in progress, by submitting your vote.
    /// This is a gas-expedient mechanism for new members to join and vote.
    /// This is not meant to stop malicious behavior.
    function joinWithVote(uint256 proposalId, bool memberVote)
        external
        payable
    {
        _join(msg.sender, msg.value);
        // Repeated vote will revert
        // Non-member vote will revert
        // Invalid proposal will revert
        _vote(proposalId, msg.sender, memberVote, false);
    }

    function _join(address newMember, uint256 fee) private {
        require(fee == 1 ether, "INVALID_FEE");
        require(!members[newMember], "ALREADY_MEMBER");

        members[newMember] = true;
        memberCount++;

        emit NewMember(newMember);
    }

    /*
     * PROPOSAL
     */

    /// Return the status of a proposal
    /// @param proposalId Proposal ID
    /// @return ProposalStatus
    function proposalStatus(uint256 proposalId)
        public
        view
        returns (ProposalStatus)
    {
        if (proposalId >= nextProposalId) {
            return ProposalStatus.NotCreated;
        }

        Proposal storage proposal = proposals[proposalId];

        if (proposal.canceled || proposal.executionCompleted) {
            return ProposalStatus.Closed;
        } else if (block.timestamp < proposal.proposedAt + VOTING_DURATION) {
            return ProposalStatus.Voting;
        } else if (
            block.timestamp <
            proposal.proposedAt + VOTING_DURATION + EXECUTION_DURATION
        ) {
            if (proposal.executing) {
                return ProposalStatus.Executing;
            } else if (
                (proposal.totalVotes > (memberCount * QUOREM_PERCENT) / 100) &&
                (proposal.yayVotes > proposal.totalVotes - proposal.yayVotes)
            ) {
                return ProposalStatus.ReadyForExecute;
            }
        }

        return ProposalStatus.Closed;
    }

    /// Create a new proposal. Only one proposal can be entertained a time.
    /// The prior one must closed before a new one can be accepted.
    /// @param targets Call targets
    /// @param values ETH values to send
    /// @param signatures Function signatures to call
    /// @param calldatas Calldata to send
    function propose(
        address[] calldata targets,
        uint256[] calldata values,
        string[] calldata signatures,
        bytes[] calldata calldatas
    ) external onlyMembers(msg.sender) {
        uint256 newProposalId = nextProposalId++;

        Proposal storage proposal = proposals[newProposalId];
        proposal.proposer = msg.sender;
        proposal.hash = _hashProposal(targets, values, signatures, calldatas);
        proposal.proposedAt = block.timestamp;

        emit NewProposal(newProposalId, targets, values, signatures, calldatas);
    }

    /// Cancel a proposal.  Allowed unless currently Executing or Closed.
    /// @param proposalId The proposal to cancel
    function cancel(uint256 proposalId) external validProposal(proposalId) {
        Proposal storage proposal = proposals[proposalId];
        require(msg.sender == proposal.proposer, "NOT_PROPOSER");
        require(
            block.timestamp < proposal.proposedAt + CANCEL_PERIOD,
            "CANNOT_CANCEL"
        );

        proposal.canceled = true;

        emit ProposalCanceled(proposalId);
    }

    function _hashProposal(
        address[] calldata targets,
        uint256[] calldata values,
        string[] calldata signatures,
        bytes[] calldata calldatas
    ) private pure returns (bytes32) {
        require(
            targets.length == values.length &&
                targets.length == signatures.length &&
                targets.length == calldatas.length &&
                targets.length > 0,
            "INVALID_ARITY"
        );
        return keccak256(abi.encode(targets, values, signatures, calldatas));
    }

    /*
     * VOTE
     */

    /// Retrieve a member vote on a proposal
    /// @param proposalId The proposal
    /// @param member The member
    /// @return Vote the member's vote record
    function getMemberVote(uint256 proposalId, address member)
        external
        view
        returns (Vote memory)
    {
        return proposals[proposalId].votes[member];
    }

    /// A member may submit their vote directly
    /// @param proposalId The proposal being voted on
    /// @param memberVote True = Yes, False = No
    function vote(uint256 proposalId, bool memberVote) external {
        // Repeated votes will revert
        // Non-member votes will revert
        // Invalid proposal will revert
        _vote(proposalId, msg.sender, memberVote, false);
    }

    /// A member vote submitted by signature.
    /// @param proposalId The proposal being voted on
    /// @param memberVote True = Yes, False = No
    /// @param v Signature v
    /// @param r Signature r
    /// @param s Signature s
    function voteBySig(
        uint256 proposalId,
        bool memberVote,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Repeated vote will revert
        // Non-member vote will revert
        // Invalid proposal will revert
        _voteBySig(proposalId, memberVote, v, r, s, false);
    }

    /// A batch of member votes submitted by signature
    /// @param proposalId The proposal being voted on
    /// @param memberVotes True = Yes, False = No
    /// @param v Signature v
    /// @param r Signature r
    /// @param s Signature s
    function batchVoteBySig(
        uint256[] calldata proposalId,
        bool[] calldata memberVotes,
        uint8[] calldata v,
        bytes32[] calldata r,
        bytes32[] calldata s
    ) external {
        require(
            proposalId.length == memberVotes.length &&
                proposalId.length == v.length &&
                proposalId.length == r.length &&
                proposalId.length == s.length,
            "INVALID_ARITY"
        );
        for (uint256 i = 0; i < memberVotes.length; i++) {
            // Repeated votes will be ignored
            // Votes by non-members will be ignored
            // Invalid proposals will be ignored
            _voteBySig(proposalId[i], memberVotes[i], v[i], r[i], s[i], true);
        }
    }

    function _voteBySig(
        uint256 proposalId,
        bool memberVote,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bool isBatchVote
    ) private {
        address signatory = ecrecover(
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domainSeparator,
                    keccak256(abi.encode(VOTE_TYPEHASH, proposalId, memberVote))
                )
            ),
            v,
            r,
            s
        );

        _vote(proposalId, signatory, memberVote, isBatchVote);
    }

    function _vote(
        uint256 proposalId,
        address member,
        bool memberVote,
        bool isBatchVote
    ) private {
        // Only members can vote
        if (!members[member]) {
            if (isBatchVote) {
                return;
            } else {
                revert("NOT_MEMBER");
            }
        }

        // Proposal must be valid, and currently voting
        ProposalStatus status = proposalStatus(proposalId);
        if (status != ProposalStatus.Voting) {
            if (isBatchVote) {
                return;
            } else {
                if (status == ProposalStatus.NotCreated) {
                    revert("INVALID_PROPOSAL");
                } else {
                    revert("NOT_VOTING");
                }
            }
        }

        // Members cannot vote multiple times
        Proposal storage proposal = proposals[proposalId];
        if (proposal.votes[member].exists) {
            if (isBatchVote) {
                return;
            } else {
                revert("ALREADY_VOTED");
            }
        }

        proposal.votes[member] = Vote({exists: true, vote: memberVote});
        proposal.totalVotes++;
        if (memberVote) {
            proposal.yayVotes++;
        }
        emit NewVote(proposalId, member, memberVote);
    }

    /*
     * EXECUTE
     */

    /// Execute a succeeded proposal during the execution period
    /// @param proposalId The proposal being executed
    /// @param targets Call targets
    /// @param values ETH values to send
    /// @param signatures Function signatures to call
    /// @param calldatas Calldata to send
    function execute(
        uint256 proposalId,
        address[] calldata targets,
        uint256[] calldata values,
        string[] calldata signatures,
        bytes[] calldata calldatas
    ) external onlyMembers(msg.sender) {
        require(
            proposalStatus(proposalId) == ProposalStatus.ReadyForExecute,
            "CANNOT_EXECUTE)"
        );
        Proposal storage proposal = proposals[proposalId];
        require(
            _hashProposal(targets, values, signatures, calldatas) ==
                proposal.hash,
            "INVALID_EXECUTION"
        );

        // Prevent re-entrency concerns during execution
        proposal.executing = true;

        bool success;
        bytes memory calldata_;

        for (uint256 i = 0; i < targets.length; i++) {
            if (bytes(signatures[i]).length == 0) {
                // Not calling a function
                calldata_ = calldatas[i];
            } else {
                calldata_ = abi.encodePacked(
                    bytes4(keccak256(bytes(signatures[i]))),
                    calldatas[i]
                );
            }
            (success, ) = targets[i].call{value: values[i]}(calldata_);
            require(success, "EXECUTION_FAILED");
        }

        proposal.executing = false;
        proposal.executionCompleted = true;

        emit ProposalExecuted(proposalId);
    }

    /// Primary method expected to be called via proposals
    /// @param nftContract Address of the NFT contract to purchase
    /// @param nftId Id of the NFT to purchase
    /// @param value Purchase value
    /// @dev This can only be called from this contract, via proposal
    function buyFromNftMarketplace(
        address nftContract,
        uint256 nftId,
        uint256 value
    ) external nonReentrant {
        require(msg.sender == address(this), "ONLY_INTERNAL");
        require(value <= address(this).balance, "INSUFFICIENT_FUNDS");
        uint256 currentNftPrice = nftMarketplace.getPrice(nftContract, nftId);
        require(currentNftPrice <= value, "INSUFFICIENT_FUNDS");

        bool success = nftMarketplace.buy{value: currentNftPrice}(
            nftContract,
            nftId
        );
        require(success, "NFT_BUY_FAILED");

        emit NftPurchaseCompleted(nftContract, nftId, value, currentNftPrice);
    }

    /// Allows this contract to receive ERC721 from contracts that use safe transfer methods
    /// @param operator Callback initiator
    /// @param from Prior NFT owner
    /// @param tokenId Nft token id
    /// @param data Additional data
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4) {
        emit NftReceived(operator, from, tokenId, data);
        return ERC721_RECEIVER;
    }
}
