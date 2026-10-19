# Repository instructions

Smart Router is a TypeScript ESM CLI over the pinned OpenCode SDK/server 1.19.3. User-facing text and public documentation are in English. Task classification must continue to support English and Spanish.

Use npm test, npm run test:permissions, npm run typecheck and npm run build for code changes. Native smokes use local scripted providers and isolated configuration. Never introduce real model credentials into CI or ordinary tests. Paid benchmark and diagnostic commands require explicit authorization and --run.

Preserve approvals, secret-path restrictions, project locks, existing user changes, and the distinction between validation evidence, provider errors, permission failures, local limits, and unknown costs. A model statement is not proof that a test passed. Cost zero requires evidence.

Keep public docs focused on reproducible setup and behavior. Generated reports and histories belong outside tracked files. Do not add local paths or real session/generation identifiers. Run npm run audit:public and the appropriate smoke before publishing. No automatic npm publication.
