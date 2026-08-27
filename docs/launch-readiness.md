# Public Repository Launch Readiness

- **Status:** In progress
- **Updated:** 2026-08-27
- **Repository:** [theaiteam-dev/conduit](https://github.com/theaiteam-dev/conduit)

This checklist is the launch gate for Conduit's fresh public repository. It
tracks only work needed to make the repository understandable, runnable, and
safe for outside contributors. Product sequencing lives in
[`ROADMAP.md`](../ROADMAP.md); implementation sequencing lives in
[`build-order.md`](./build-order.md).

## Repository foundation

- [x] Start from a source snapshot without the previous repository's branches,
  pull requests, or commit history.
- [x] Add an MIT license owned by Josh Owens.
- [x] Add contribution, security, and community-conduct policies.
- [x] Provide a safe `.env.example` and ignore local secrets and runtime data.
- [x] Point repository, clone, issue, and homepage metadata at
  `https://github.com/theaiteam-dev/conduit`.
- [x] Check committed content for credentials, private repository coordinates,
  personal filesystem paths, and customer names.
- [x] Create the initial commit, attach the public remote, and verify the default
  branch is `main`.

## Developer-preview documentation

- [x] Explain Conduit's quality loop, design commitments, and current feature
  surface in the README.
- [x] Document Docker engine builds, per-flow images, state mounts, secrets, and
  `conduit doctor` in [`installation.md`](./installation.md).
- [x] Keep the README, roadmap, SPEC, and build order consistent about shipped
  and planned capabilities.
- [x] Validate local Markdown file links and section anchors.
- [x] Add a short README quickstart that a developer can run from a clean
  checkout without first reading the full deployment guide.
- [x] Run the documented quickstart on a clean machine and record the exact
  supported Bun and Docker prerequisites.
- [x] Publish a concise comparison explaining when to use Conduit instead of a
  durable workflow engine or a general automation framework.

## Launch operations

- [x] Verify tests and typechecking pass in the public GitHub Actions context.
- [ ] Confirm issue and pull-request templates contain no private workflow
  assumptions.
- [ ] Publish the first public version tag and release notes.
- [ ] Publish the corresponding Docker engine image and document its immutable
  tag.
- [ ] Exercise the security-reporting address and coordinated-disclosure path.

## Ongoing rule

Every user-visible behavior change must update the relevant guide and the public
changelog in the same pull request. Local Markdown links should be checked in CI
so moved PRDs and renamed SPEC sections cannot silently break navigation.
