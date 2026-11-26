#!/usr/bin/env python3
"""Independent generator for test/fixtures/jobid_vectors.json (Python: eth_abi + pycryptodome).

Not used by the JS codec or the contract, so it is a third implementation of the same rule:
  TAG   = keccak256("FlopReceiptRoot.jobId.v1")
  jobId = keccak256(abi.encode(bytes32 TAG, bytes32 genesis, bytes32 channelId, uint64 settledBlock, uint32 eventIndex))
Run: python3 scripts/gen_jobid_vectors.py > test/fixtures/jobid_vectors.json
"""
import json
from pathlib import Path
from Crypto.Hash import keccak
from eth_abi import encode

def k(b: bytes) -> bytes:
    h = keccak.new(digest_bits=256); h.update(b); return h.digest()

TAG_STRING = "FlopReceiptRoot.jobId.v1"
TAG = k(TAG_STRING.encode())
TYPES = ["bytes32", "bytes32", "bytes32", "uint64", "uint32"]
hx = lambda b: "0x" + b.hex()

def case(name, genesis, channel, block, idx):
    enc = encode(TYPES, [TAG, bytes.fromhex(genesis[2:]), bytes.fromhex(channel[2:]), int(block), int(idx)])
    assert len(enc) == 160
    return {"name": name, "genesis": genesis, "channelId": channel, "settledBlock": str(block),
            "eventIndex": str(idx), "encoded": hx(enc), "jobId": hx(k(enc))}

ep = json.loads(Path(__file__).resolve().parent.parent.joinpath("test/fixtures/epoch.json").read_text())
cases = []
for i in (0, 1, len(ep["items"]) - 1):
    f = ep["items"][i]["fields"]
    cases.append(case(f"devnet epoch.json item {i}", f["genesis"], f["channelId"], f["settledBlock"], f["eventIndex"]))
f0 = ep["items"][0]["fields"]
cases.append(case("item 0 with eventIndex+1 (must differ)", f0["genesis"], f0["channelId"], f0["settledBlock"], int(f0["eventIndex"]) + 1))
cases.append(case("all zero", "0x" + "00" * 32, "0x" + "00" * 32, 0, 0))
cases.append(case("max widths (uint64, uint32)", "0x" + "ff" * 32, "0x" + "ff" * 32, 2**64 - 1, 2**32 - 1))
print(json.dumps({
    "rule": "jobId = keccak256(abi.encode(bytes32 TAG, bytes32 genesis, bytes32 channelId, uint64 settledBlock, uint32 eventIndex))",
    "tagString": TAG_STRING, "tag": hx(TAG), "encodedBytes": 160,
    "generator": "scripts/gen_jobid_vectors.py (eth_abi + pycryptodome), independent of src/codec.mjs and the contract",
    "count": len(cases), "cases": cases}, indent=1))
