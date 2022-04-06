# CollectorDAO

## About

This is an NFT collector DAO.  New members can `join()` for 1 ETH. If there is a vote presently open, you have the option to `joinWithVote()`.  We like that you know where your money might be going immediately upon joining :).

### Proposals

We expect you'll propose calls to `buyNftFromMarketplae()`, but it's up to you. If you don't like your proposal, you can cancel it within roughly 1hr of proposing.

### Voting

Your 1 ETH membership fee buys you one vote per proposal. Once you've voted, that's it: no re-votes. You can `vote()` directly, `voteBySignature()`, or have someone `batchVoteBySignature()` for you too. Voting lasts for 3 days from the time a proposal is created.  The voting period ends only after three days, no matter how many votes do or don't come in during that time.  Nobody can do anything but vote on your proposal during voting period. The `joinWithVote()` option is a mechanism to ensure an informed membership.

Once the voting period ends, the curious can check `proposalStatus()` for whether it passed (`ReadyForExecution`) or failed (`Closed`). Quorem is 25% of total membership, and the number of yes's must be > no's. If `ReadyForExecution`, see the next section.  If `Closed`, someone can submit a new proposal for consideration.

### Execution

Any member can `execute()` a proposal that is `ReadyForExecution`, for up to 3 days after voting period ends, by re-issuing the proposed method arguments. Once executed, the proposal is `Closed`, and a new proposal can be created. If no one executes the proposal, or it never succeeds, it will automatically become `Closed` at the end of the 3 day execution period.


## Getting Started

To setup the local environment:

```bash
npm install
```

To run tests:

```bash
npx hardhat typechain
npx hardhat test
```

