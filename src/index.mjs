// Library entry. Build and check epochs, sign roots with local keys, verify proofs. Read-only: nothing broadcasts.
export { toLeafFields, encodeLeaf, leafHash, ss58ToPubkey, digest712, LEAF_TYPE, ROOT_TYPE, hex, unhex, jobId, encodeJobId, JOB_ID_TAG, JOB_ID_TAG_STRING } from './codec.mjs';
export { buildTree, proofFor, proofPath, verifyProof, hexProof } from './merkle.mjs';
export { buildEpoch, NETWORKS } from './epoch.mjs';
export { finalizedHead, settlementsSince } from './fetch.mjs';
export { signRoot, recoverSigner, sortBySigner, addressOf } from './attest.mjs';
export { compareFacts, crossCheck, readChainFacts, connectRpc, rpcFinalized, rpcHashAt } from './rpc.mjs';
export { findItem, calldata, proofBundle, verifyReceipt, settlementTuple, proofArg, VERIFY_SIG, FILL_SIG } from './receipt.mjs';
