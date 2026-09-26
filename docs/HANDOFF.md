# Development handoff — 2026-09-26

This repository is an unfinished development snapshot. The requested result is a separate Windows application named ChatGPT Science, preserving the reference application's UI/UX and functions while using genuine ChatGPT authentication and inference. It must not modify, stop, or share research data with a running Claude Science installation. There is no accepted release executable yet.

The published tree excludes vendor binaries and compiled frontend assets, local runtimes, user profiles, research data, credentials, test outputs and archived builds. A local external 0.1.50 renderer is used for interoperability testing; its absence from a fresh checkout is expected. Do not replace the target with the earlier `web/` prototype and call it complete.

## Implementation map

| Path | Responsibility |
| --- | --- |
| `desktop/main.cjs` | Electron lifecycle, isolated app data/profile, authenticated local server, `/reference/` entry |
| `server/index.mjs` | Application API, projects/sessions, model dispatch, approvals and research tools |
| `server/codex-bridge.mjs` | Official Codex App Server, genuine ChatGPT accounts, restricted owned tools and reconnect |
| `server/store.mjs` | Atomic project storage and restart recovery |
| `server/artifacts.mjs`, `pdf-content.mjs` | Immutable versions, previews, model content, annotations, provenance and exports |
| `server/kernel-client.mjs`, `worker/` | Persistent Python/R, logs, interruption and owned process lifecycle |
| `server/integrations.mjs` | MCP transports/OAuth, literature, SSH/Slurm/Modal and cloud storage |
| `server/reference-ui.mjs` | Reference REST/WS startup/account/settings contract and adapter mounting |
| `server/reference-chat.mjs` | Project/frame/message DTOs, stream updates, approvals and transcript metadata |
| `server/reference-compute.mjs` | Reference compute/environment/terminal contract |
| `server/reference-connections.mjs` | Newly written MCP/memory/skills routes; not yet mounted |
| `scripts/prepare-reference-ui.mjs` | Hash-checked, AST-scoped provider changes to locally supplied assets |
| `reference-adapter/provider-login.js` | Browser login, polling, cancellation and app-local disconnect |

## Verified history and limits

A publication-time run on 2026-09-26 passed 104 tests with zero failures, skips or cancellations in about 29 seconds. It ran on the development machine with its app-local Python/R environments installed. This supersedes the earlier 99-test baseline but does not prove complete feature parity, UI acceptance, or setup on a fresh machine.

Genuine managed ChatGPT account discovery, app-local disconnect/reconnect and eight available models were separately verified that day. General tests use fixtures for model behavior; that is distinct from the live-account evidence.

The reference renderer previously sent a real message and displayed a ChatGPT answer. Persistent Python/R and output provenance have service-level tests, including the five reference-compute cases in the publication run. The updated UI flows and packaged EXE have not passed complete end-to-end acceptance.

## Immediate gaps

`reference-chat.mjs` now sends an `attachmentVersions` map with selected viewport artifacts. `index.mjs` still accepts only `attachmentIds` and uses current versions. Validate each requested version against its artifact/project, persist the immutable reference and pass it to model reads. Do not silently substitute a newer version.

Mount `mountReferenceConnections(router, ctx)` before old overlapping memory/skills aliases. Wire `referenceConnectorPolicy(connection, toolName, agentName)` into the real connector dispatcher, including revocation checks, and `referenceMemoryContext(store, projectId, sessionId)` into model context. UI settings alone must not claim to restrict model behavior. Skill enable/disable needs an effective backend hook.

`server/reference-artifacts.mjs` and its tests have not been created. Implement the original artifact index, project/frame lists, multipart/chunk upload, raw/version routes, save/copy/rename/folders, annotations, notes, lineage and review contract using existing owned services. The renderer expects fields such as `version_id`, `root_frame_id` and `content_type`. Do not invent structured reviewer pass/fail checks from prose responses.

Newest chat changes include dashboard session arrays, seen-session synchronization, transcript annotations and an aside route; existing chat tests do not cover all of them. The connection adapter has no dedicated tests. Full branching/fork-at-answer, plan approval and parts of cloud/GPU compute remain unsupported.

Account menu dispatch now maps to app-only disconnect and is labelled accordingly; complete the visible disconnect → ChatGPT login → return-to-workspace test. A reconnect helper exists but is not yet surfaced clearly in the login UI. Do not expose shared `account/logout` as app-only sign-out.

The renderer previously crashed on an existing-project dashboard because required arrays were absent. A DTO fix is in source but has not been browser-verified after restarting. Settings/Credentials also needs validation. Backend modules do not hot-reload; a running preview can lag behind source.

## Explicit catalog requirements

| Group | Required items |
| --- | --- |
| Featured connectors | BioMart; Cancer Models; CellGuide; Chemistry; Clinical Genomics; Drug Regulatory; Expression; Genes & Ontologies; Genomes; Human Genetics; Ketcher Chemistry; Literature Graph; Omics Archives; Protein Annotation; Regulation; Research Resources; RNA; Structures & Interactions; Variants; ZINC |
| Directory connectors | bioRxiv; ChEMBL; Clinical Trials; PubMed; Claude Docs |
| Custom connectors | User-configured servers, real transport/OAuth, enable/disable and per-tool permissions |
| Featured skills | AlphaFold2; Boltz; Borzoi; Chai-1; DiffDock; Docs; ESM-2; ESMFold2; Evo 2; Google Workspace; Import Memory; Indication Dossier; LigandMPNN; Literature Review; Morning; OpenFold3; ProteinMPNN; scGPT; scvi-tools; SolubleMPNN |
| Personal/imported skills | Agentsc Daily Watch; GitHub plugin-marketplace import and personal editing |
| Specialists | User-defined Sentinel, built-in Reviewer, creation/search/configuration/enable/disable and actual delegation |

Named catalogs and specialists are not complete. A scientific-skills module was planned but not created. User-specific definitions are not in this repository. A catalog name does not prove its environment is installed, a server is connected or an external query succeeded. Do not transplant the reference application's Connected flags or credentials.

## Full acceptance scope

Acceptance includes projects/persistence, scoped memory, streaming conversations/plans/parallel agents, artifact tabs/versions, scientific document/media/molecule/structure/genome/MSA viewers, version-bound annotations, persistent Python/R, reusable analysis environments, resource monitoring, execution provenance, evidence-based reviewer behavior, skills, MCP/literature, scientific databases, SSH/Slurm, cloud compute/storage, remote deployment, enforced permissions, usage/notifications and project exports.

Preserving a visual control is not completion of its function. Host execution is currently not an operating-system sandbox. External paid compute and account-dependent integrations need valid configuration and scoped authorization; mocks cannot establish full parity.

## Next work

Complete pending service hooks and the artifact module, extend tests for newly landed routes, then test the renderer's dashboard, login, message/stop/reload, pinned attachments, Files/Library, annotations, Python/R and settings. Implement and validate named catalog and specialist workflows. Produce and test a portable EXE from that source state, with no credentials or research fixtures in the package.

When resuming on an existing machine, verify actual process identities before restarting only an owned preview or kernel. Do not kill processes by general Claude/Electron/Node names. Keep separate data, profiles, ports and authentication boundaries.
