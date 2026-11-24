# Security

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security tab → Advisories). Please do not open a public issue.

In scope: a settlement that verifies against a root it is not in; a root accepted without a real quorum; signature malleability or replay across chains or contracts; the escrow paying without a valid proof, paying twice for one settlement, or losing or locking funds; the builder writing a root the chain disagrees with; scripts touching anything but a fresh local anvil.

This code is not deployed anywhere and holds no funds. Contracts are unaudited prototypes.
