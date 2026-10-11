// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title EvidenceRegistry
/// @notice Append-only log of ArcFlow Sentinel evidence anchors. Stores nothing and holds no
/// value: each call only emits an event binding a trace id to the keccak256 of its canonical
/// evidence bundle. The bundle itself lives off chain; verifiers recompute its hash and compare.
contract EvidenceRegistry {
    event EvidenceAnchored(
        bytes32 indexed traceId,
        bytes32 indexed evidenceHash,
        uint8 status,
        uint64 observedAt,
        address indexed submitter
    );

    function anchor(bytes32 traceId, bytes32 evidenceHash, uint8 status, uint64 observedAt) external {
        emit EvidenceAnchored(traceId, evidenceHash, status, observedAt, msg.sender);
    }
}
