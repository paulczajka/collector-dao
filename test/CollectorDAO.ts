import { expect } from "chai";
import { network, ethers } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

const {deployMockContract} = require('@ethereum-waffle/mock-contract');

import { CollectorDAO, NftMarketplace } from "../typechain";
import * as INftMarketplace from "../artifacts/contracts/CollectorDAO.sol/NftMarketplace.json";
import { BigNumber } from "ethers";

describe("CollectorDAO", function () {

  const QUOREM_PERCENT = 25;
  const CANCEL_PERIOD: number = 60 * 4;
  const VOTING_DURATION: number = 3 * 24 * 60 * 4;
  const EXECUTION_DURATION: number = 3 * 24 * 60 * 4;

  const TARGETS = 0;
  const VALUES = 1;
  const SIGNATURES = 2;
  const CALLDATAS = 3;

  enum ProposalStatus { NotCreated = 0, Voting = 1, ReadyForExecute = 2, Executing = 3, Closed = 4 }

  function abiEncode(types: string[], values: any[]) {
    const abiEncoder = new ethers.utils.AbiCoder();
    return abiEncoder.encode(types, values);
  }

  function functionSig(s: string): string {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s)).slice(0,10);
  }

  async function votingEnd(): Promise<number> {
    let block: number = (await ethers.provider.getBlockNumber()) + 1;
    return block + VOTING_DURATION;
  }

  async function executionEnd(): Promise<number> {
    return (await votingEnd()) + EXECUTION_DURATION;
  }

  async function advanceSeconds(seconds: number) {
    await network.provider.send("evm_increaseTime", [seconds])
    await ethers.provider.send("evm_mine", []);
  }

  async function advanceMinutes(minutes: number) {
    let hoursInSeconds = minutes * 60;
    await advanceSeconds(hoursInSeconds);
  }

  async function advanceDays(days: number) {
    let daysInSeconds = days * 24 * 60 * 60;
    await advanceSeconds(daysInSeconds);
  }

  async function readyProposalForExecution(proposal: Proposal) {

    // Create a proposal to vote on
    await dao.connect(alice).propose(...proposal);

    // Pass quorem
    for(let i = 0; i < 6; i++) {
      await dao.connect(members[i]).vote(1, true);
    }

    // Move to execution period
    await advanceDays(4);
    expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.ReadyForExecute);
  }


  let chainId: number;
  let dao: CollectorDAO;
  let mockNftMarketplace: any;

  let owner: SignerWithAddress;   // deployer/owner
  let alice: SignerWithAddress;   // member and voter
  let bob: SignerWithAddress;     // member and voter
  let members: SignerWithAddress[]; // Alice, Bob, and 8 more addrs: joined members
  let missAnneThrope: SignerWithAddress; // She's having none of all of this

  let targets: string[];
  let values: BigNumber[];
  let signatures: string[];
  let calldatas: string[];

  type Proposal =  [string[], BigNumber[], string[], string[]];
  let buyOneNft: Proposal;
  let buyTwoNfts: [string[], BigNumber[], string[], string[]];

  const parseEther = ethers.utils.parseEther;

  beforeEach(async function () {
    [owner, alice, bob, missAnneThrope, ...members] = await ethers.getSigners();
    members = [alice, bob, ...members.slice(0,8)];
    chainId = (await ethers.provider.getNetwork()).chainId;

    mockNftMarketplace = await deployMockContract(owner, INftMarketplace.abi);

    let daoFactory = await ethers.getContractFactory("CollectorDAO");
    dao = <CollectorDAO>await daoFactory.deploy(mockNftMarketplace.address);
    await dao.deployed()

    // Make 10 total members
    for(let i = 0; i < members.length; i++) {
      await dao.connect(members[i]).join({value: parseEther("1")});
    }

    buyOneNft = [
      // target
      [ dao.address ],
      // value
      [ parseEther("0") ],
      // signature
      [ "buyFromNftMarketplace(address,uint256,uint256)" ],
      // calldata
      [ abiEncode(["address", "uint256", "uint256"],[mockNftMarketplace.address, "1", parseEther("1")]) ]
    ];

    buyTwoNfts = [
      // target
      [
        dao.address,
        dao.address
      ],
      // value
      [
        parseEther("0"),
        parseEther("0")
      ],
      // signature
      [
        "buyFromNftMarketplace(address,uint256,uint256)",
        "buyFromNftMarketplace(address,uint256,uint256)",
      ],
      // calldata
      [
        abiEncode(["address", "uint256", "uint256"],[mockNftMarketplace.address, "10", parseEther("0.1")]),
        abiEncode(["address", "uint256", "uint256"],[mockNftMarketplace.address, "11", parseEther("0.2")])
      ]
    ];
  });

  describe("joining DAO", async function() {
    it("reverts if invalid fee", async function() {
      // Provide 1 wei less than 1 ETH
      let nopeFee = parseEther("1").sub(1);
      await expect(dao.connect(missAnneThrope).join({value: nopeFee})).to.be.
        revertedWith("INVALID_FEE");
    });

    it("reverts if repeated", async function() {
      await expect(dao.connect(alice).join({value: parseEther("1")})).to.be.
        revertedWith("ALREADY_MEMBER");
    });

    it("registers the new member and funds increase", async function() {
      // 10 members already added in a beforeEach() above
      expect(await dao.memberCount()).to.equal(10);
      expect(await ethers.provider.getBalance(dao.address)).to.equal(parseEther("10"));
    });

    it("registers a new member and their vote", async function() {
      // A new proposal is immediately open for voting
      await dao.connect(alice).propose(...buyOneNft);

      // New members can join with a vote
      await dao.connect(missAnneThrope).joinWithVote(1, false, {value: parseEther("1")});

      let vote = await dao.getMemberVote(1, missAnneThrope.address);
      expect(await dao.members(missAnneThrope.address)).to.be.true;
      expect(vote.exists).to.be.true;
      expect(vote.vote).to.be.false;
      expect((await dao.proposals(1)).totalVotes).to.equal(1);
    });
  });

  describe("proposal", async function() {
    it("reverts if called by non-member", async function(){
      await expect(dao.connect(missAnneThrope).propose(...buyOneNft)).to.be.
        revertedWith("NOT_MEMBER");
    });

    it("can be created for a single function call", async function() {
      await expect(dao.connect(alice).propose(...buyOneNft)).
        to.emit(dao, 'NewProposal').
        withArgs(1, ...buyOneNft);
    });

    it("can be created with multiple function calls", async function() {
      await expect(dao.connect(alice).propose(...buyTwoNfts)).
        to.emit(dao, 'NewProposal').
        withArgs(1, ...buyTwoNfts);
    });

    it("can create multiple proposals concurrently", async function() {
      await dao.connect(alice).propose(...buyOneNft);

      // Prior proposal still open
      await expect(dao.connect(alice).propose(...buyTwoNfts)).to.not.be.reverted;
    });

    it("is immediately available for Voting", async function() {
      await dao.connect(alice).propose(...buyOneNft);

      expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.Voting);
    });
  });

  describe("voting", async function() {
    beforeEach(async function() {
      // Create proposal 0
      await dao.connect(alice).propose(...buyOneNft);
    });

    describe("directly", async function() {
      it("reverts if invalid proposal", async function() {
        // proposal 1 isn't valid
        await expect(dao.connect(alice).vote(2, true)).to.be.
          revertedWith("INVALID_PROPOSAL");
      });

      it("reverts if not member", async function() {
        await expect(dao.connect(missAnneThrope).vote(1, false)).to.be.
          revertedWith("NOT_MEMBER");
      });

      it("registers the votes correctly", async function() {
        // Alice votes Yes
        await dao.connect(alice).vote(1, true);
        let yesVote = await dao.getMemberVote(1, alice.address);
        expect(yesVote.exists).to.be.true;
        expect(yesVote.vote).to.be.true;

        // Bob votes No
        await dao.connect(bob).vote(1, false);
        let noVote = await dao.getMemberVote(1, bob.address);
        expect(noVote.exists).to.be.true;
        expect(noVote.vote).to.be.false;

        // Proposal Total and YesVote counts should be accurate
        let proposal = await dao.proposals(1);
        expect(proposal.totalVotes).to.equal(2);
        expect(proposal.yayVotes).to.equal(1);
      });

      it("reverts if no longer voting", async function() {
        // Voting period only lasts three days
        await advanceDays(4);
        await expect(dao.connect(alice).vote(1, true)).to.be.
          revertedWith("NOT_VOTING");
      });
    });

    describe("by signature", async function() {
      let domain: any;
      let types: any;

      beforeEach(async function() {
        domain = {
          name: 'CollectorDAO',
          chainId: chainId,
          verifyingContract: dao.address,
        };
        types = {
          SigVote: [
            { name: 'proposalId', type: 'uint256' },
            { name: 'memberVote', type: 'bool' },
          ]
        };
      });

      it("registers vote of signatory submitted by a non-member", async function() {
        // Alice votes yes
        const message = { proposalId: 1, memberVote: true };
        const signature = await alice._signTypedData(domain, types, message);
        const sig = ethers.utils.splitSignature(signature);

        // Bob submits Alice's vote
        await expect(dao.connect(bob).voteBySig(1, true, sig.v, sig.r, sig.s)).to.
          emit(dao, "NewVote").
          withArgs(1, alice.address, true);

        // Expect just Alice's Yes-vote was registered
        expect((await dao.getMemberVote(1, alice.address)).vote).to.be.true;
        expect((await dao.proposals(1)).totalVotes).to.equal(1);
      });

      it("reverts if nonmember signs", async function() {
        // Miss Thrope is not a member
        const message = { proposalId: 1, memberVote: false };
        const signature = await missAnneThrope._signTypedData(domain, types, message);
        const sig = ethers.utils.splitSignature(signature);

        // Alice submits Anne's vote
        await expect(dao.connect(alice).voteBySig(1, true, sig.v, sig.r, sig.s)).to.be.
          revertedWith("NOT_MEMBER");

        // Expect no votes to be registered
        expect((await dao.proposals(1)).totalVotes).to.equal(0);
      });

      describe("batch", async function() {
        it("registers all votes, skipping if non-member or existing votes", async function() {
          // Alice votes Yes initially, MANUALLY
          await dao.connect(alice).vote(1, true);

          // Alice also has a No vote, BY SIGNATURE (this will be ignored)
          const a_message = { proposalId: 1, memberVote: false };
          const a_signature = await alice._signTypedData(domain, types, a_message);
          const a_sig = ethers.utils.splitSignature(a_signature);

          // Bob votes no BY SIGNATURE
          const b_message = { proposalId: 1, memberVote: false };
          const b_signature = await bob._signTypedData(domain, types, b_message);
          const b_sig = ethers.utils.splitSignature(b_signature);

          // Miss Thrope is not a member (this should be skipped)
          const t_message = { proposalId: 1, memberVote: true };
          const t_signature = await missAnneThrope._signTypedData(domain, types, t_message);
          const t_sig = ethers.utils.splitSignature(t_signature);

          // Carol votes yes BY SIGNATURE
          let carol = members[5];
          const c_message = { proposalId: 1, memberVote: true };
          const c_signature = await carol._signTypedData(domain, types, c_message);
          const c_sig = ethers.utils.splitSignature(c_signature);

          await dao.batchVoteBySig(
            [a_message.proposalId, b_message.proposalId, t_message.proposalId, c_message.proposalId],
            [a_message.memberVote, b_message.memberVote, t_message.memberVote, c_message.memberVote],
            [a_sig.v, b_sig.v, t_sig.v, c_sig.v],
            [a_sig.r, b_sig.r, t_sig.r, c_sig.r],
            [a_sig.s, b_sig.s, t_sig.s, c_sig.s]
          );

          // Expect Alice=yes, Bob=no, Carol=yes, and 3 total votes
          let aliceVote = await dao.getMemberVote(1, alice.address);
          let bobVote = await dao.getMemberVote(1, bob.address);
          let carolVote = await dao.getMemberVote(1, carol.address);
          let missAnneThropeVote = await dao.getMemberVote(1, missAnneThrope.address);

          expect(aliceVote.exists).to.be.true;
          expect(aliceVote.vote).to.be.true;
          expect(bobVote.exists).to.be.true;
          expect(bobVote.vote).to.be.false;
          expect(carolVote.exists).to.be.true;
          expect(carolVote.vote).to.be.true;
          expect(missAnneThropeVote.exists).to.be.false;
        });

        it("skips votes for invalid proposalIds", async function() {
          // Alice votes Yes for Proposal 1 (correct proposal)
          const a_message = { proposalId: 1, memberVote: true };
          const a_signature = await alice._signTypedData(domain, types, a_message);
          const a_sig = ethers.utils.splitSignature(a_signature);

          // Bob votes Yes for Proposal 2 (invalid proposal)
          const b_message = { proposalId: 2, memberVote: true };
          const b_signature = await bob._signTypedData(domain, types, b_message);
          const b_sig = ethers.utils.splitSignature(b_signature);

          await expect(dao.batchVoteBySig(
            [a_message.proposalId, b_message.proposalId],
            [a_message.memberVote, b_message.memberVote],
            [a_sig.v, b_sig.v],
            [a_sig.r, b_sig.r],
            [a_sig.s, b_sig.s]
          )).to.not.be.reverted;

          // Expect no votes registered
          let aliceVote = await dao.getMemberVote(1, alice.address);
          let bobVote = await dao.getMemberVote(2, bob.address);

          expect(aliceVote.exists).to.be.true;
          expect(aliceVote.vote).to.be.true;
          expect(bobVote.exists).to.be.false;
        });
      });
    })

    describe("when ended", async function() {
      //
      // 10 members exist: quorem is 3
      //

      it("proposal passes if quorem is reached and yes's > no's", async function() {
        // 2 Yes, 1 No
        await dao.connect(members[0]).vote(1, true);
        await dao.connect(members[1]).vote(1, true);
        await dao.connect(members[2]).vote(1, false);

        // advance into execution
        await advanceDays(4);

        // Expect we're ready to roll
        expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.ReadyForExecute);
      });

      it("proposal fails if quorem is reached and yes's <= no's", async function() {
        // 2 Yes, 2 No
        await dao.connect(members[0]).vote(1, true);
        await dao.connect(members[1]).vote(1, true);
        await dao.connect(members[2]).vote(1, false);
        await dao.connect(members[3]).vote(1, false);

        // advance into execution
        await advanceDays(4);

        // We've been shut down
        expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.Closed);
      });

      it("proposal fails if quorem is not reached", async function() {
        // 2 Yes
        await dao.connect(members[0]).vote(1, true);
        await dao.connect(members[1]).vote(1, true);

        // advance into execution
        await advanceDays(4);

        // We've been shut down
        expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.Closed);
      });
    });
  });

  describe("executing", async function() {
    let members: SignerWithAddress[];

    it("purchases one Nft", async function() {
      await readyProposalForExecution(buyOneNft);

      // Configure the mock marketplace for the upcoming purchase
      await mockNftMarketplace.mock.getPrice.returns(parseEther("0.9"));
      await mockNftMarketplace.mock.buy.returns([true, ""]);

      let daoFundsBefore = await ethers.provider.getBalance(dao.address);

      await expect(dao.connect(bob).execute(1, ...buyOneNft)).to.
        emit(dao, "NftPurchaseCompleted").
        withArgs(mockNftMarketplace.address, "1", parseEther("1"), parseEther("0.9"));

      let daoFundsAfter = await ethers.provider.getBalance(dao.address);

      expect(daoFundsAfter).to.equal(daoFundsBefore.sub(parseEther("0.9")));
    });

    it("purchases two Nft", async function() {
      await readyProposalForExecution(buyTwoNfts);

      // Configure the mock marketplace for the upcoming purchase
      await mockNftMarketplace.mock.getPrice.returns(parseEther("0.1"));
      await mockNftMarketplace.mock.buy.returns(true);

      let daoFundsBefore = await ethers.provider.getBalance(dao.address);


      // Buy two NFts at different price
      await expect(dao.connect(bob).execute(1, ...buyTwoNfts)).to.
        emit(dao, "NftPurchaseCompleted").
        withArgs(
          mockNftMarketplace.address,
          "10",
          parseEther("0.1"),
          parseEther("0.1")
      ).to.
        emit(dao, "NftPurchaseCompleted").
        withArgs(
          mockNftMarketplace.address,
          "11",
          parseEther("0.2"),
          parseEther("0.1")
      );

      let daoFundsAfter = await ethers.provider.getBalance(dao.address);

      expect(daoFundsAfter).to.equal(daoFundsBefore.sub(parseEther("0.2")));
    });

    it("reverts if the execution period is over", async function() {
      // execution period only lasts 3 days
      await readyProposalForExecution(buyTwoNfts);
      await advanceDays(4);

      await expect(dao.connect(alice).execute(1, ...buyOneNft)).to.be.
        revertedWith("CANNOT_EXECUTE");
    });
  });

  describe("canceling", async function() {
    it("reverts if not the proposer", async function() {
      // Alice creates
      await dao.connect(alice).propose(...buyOneNft);

      // Bob can't cancel
      await expect(dao.connect(bob).cancel(1)).to.be.
        revertedWith("NOT_PROPOSER");
    });

    it("reverts if invalid proposal", async function() {
      // Proposal 1 created
      await dao.connect(alice).propose(...buyOneNft);

      // Proposal 2 is invalid
      await expect(dao.connect(alice).cancel(2)).to.be.
        revertedWith("INVALID_PROPOSAL");
    });

    it("can be canceled during cancel period", async function() {
      // Creating automatically starts voting
      await dao.connect(alice).propose(...buyOneNft);
      // wait for 59 minuutes
      await advanceMinutes(59);

      // Can be canceled
      await dao.connect(alice).cancel(1);
      expect(await dao.proposalStatus(1)).to.equal(ProposalStatus.Closed);
    });

    it("cannot be canceled after cancel period ends", async function() {
      await readyProposalForExecution(buyOneNft);
      // wait for 61 minuutes
      await advanceMinutes(61);

      // Cannot Cancel anymore
      await expect(dao.connect(alice).cancel(1)).to.be.
        revertedWith("CANNOT_CANCEL");
    });
  });
});
