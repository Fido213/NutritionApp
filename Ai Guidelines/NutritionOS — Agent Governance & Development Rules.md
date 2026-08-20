# EverydayFuel — Agent Governance & Development Rules

> **Purpose:** Define how the AI coding agent must operate on the EverydayFuel codebase.
>
> **Priority:** These rules exist to prevent architectural drift, unnecessary refactors, conflicting implementations, tool-related confusion, and unstable development.
>
> **Current development model:** **DeepSeek V4 Flash is the sole implementation agent.** Other models may be used externally for planning or review, but they are not part of the repository's active development workflow unless explicitly introduced later.

---

# 1. Core Principle

EverydayFuel is currently developed by **one active coding agent: DeepSeek V4 Flash**.

DeepSeek is responsible for:

* Reading the existing project documentation
* Understanding the existing architecture
* Inspecting the actual repository
* Implementing the migration/build specification
* Implementing features
* Fixing bugs
* Writing tests
* Running builds
* Validating its work
* Reporting unresolved problems

The objective is:

> **Faithfully implement the established architecture rather than continuously redesigning it.**

Do not create unnecessary work merely because the agent has available context, tokens, or time.

---

# 2. Source of Truth

Before making substantial changes, DeepSeek must inspect the relevant project sources.

The primary sources of truth are:

1. **The actual repository**
2. **`Ai Guidelines/`**
3. **The Master Migration / Build Specification**
4. **The Agent Governance Rules**
5. **Relevant AI logs**
6. **Existing interfaces, schemas, tests, and implementation**

Documentation describes the intended architecture.

The actual codebase describes the current implementation.

If they disagree, **do not silently assume which one is correct**.

Instead:

1. Identify the discrepancy.
2. Determine whether the specification explicitly requires the change.
3. Preserve existing behavior where possible.
4. Report significant architectural conflicts.
5. Resolve the conflict based on the documented intended architecture rather than personal preference.

---

# 3. Initial Repository Inspection

Before implementing a substantial work package, DeepSeek must understand the relevant existing implementation.

Inspect:

* Project structure
* Relevant source files
* Existing interfaces
* Data models
* SQLite schema
* Migrations
* Callers and consumers
* Tests
* Configuration
* Native integrations
* AI integrations
* Related modules
* Relevant AI logs
* Build configuration

Do not rewrite code based solely on:

* File names
* Generic coding patterns
* Assumptions
* Outdated documentation
* Personal preference

The agent should understand the existing system **before modifying it**.

---

# 4. Implementation Responsibilities

DeepSeek should:

* Implement complete features
* Follow the established architecture
* Maintain existing contracts
* Integrate changes into existing systems
* Write and update tests
* Fix implementation-level bugs
* Perform required migrations
* Maintain data integrity
* Build the application
* Run relevant tests
* Inspect the final diff
* Report known limitations

The default behavior is:

> **Implement what is specified. Do not redesign what is already working.**

---

# 5. Architectural Discipline

DeepSeek may make **small, obvious implementation decisions** required to complete a task.

However, DeepSeek must not casually redesign:

* Overall application architecture
* SQLite schema
* Data ownership
* Source-of-truth decisions
* AI ↔ deterministic boundaries
* Native ↔ web boundaries
* Major state-management architecture
* Core frameworks
* Core dependencies
* Offline architecture
* Historical-data semantics

If an architectural change appears necessary, DeepSeek must first establish:

1. What currently exists
2. Why it is insufficient
3. Why the proposed change is necessary
4. What systems are affected
5. What data or contracts could be affected

Do not change architecture merely because another approach appears cleaner.

---

# 6. Change Classification

Every meaningful change should fall into one of three categories.

## GREEN — Normal Implementation

These can normally be implemented directly:

* New functionality inside existing architecture
* Tests
* Types
* Straightforward UI changes
* Local bug fixes
* Compiler fixes
* Runtime fixes
* Error handling
* Documentation
* Boilerplate
* Small refactors
* Performance improvements that preserve behavior
* Obvious dead-code removal

---

## YELLOW — Implement Carefully

These can be implemented when required by the specification, but must be explicitly considered and documented:

* Changes across multiple modules
* Changes to persistence behavior
* Changes to existing interfaces
* Changes to AI prompts
* Changes to AI output schemas
* Changes to calculations
* Changes affecting historical data
* Changes affecting multiple subsystems
* Changes to native integrations

The agent should report:

* What changed
* Why it changed
* What systems are affected
* Whether compatibility was preserved
* What risks remain

---

## RED — Architectural Change

These require deliberate architectural reasoning before implementation:

* Database/schema redesign
* Changing migration strategy
* Changing the source of truth
* Changing data ownership
* Changing historical-data semantics
* Changing AI ↔ deterministic responsibilities
* Major state-management changes
* Major native ↔ web architecture changes
* Removing major subsystems
* Introducing a major framework/runtime
* Replacing a core dependency
* Large-scale refactors
* Security architecture changes
* Changes that could invalidate stored user data

If the architecture is unclear, **do not guess**.

Document the issue and follow the established specification.

---

# 7. Scope Discipline

Stay within the scope of the assigned task.

Do not turn:

```text
Implement feature X
```

into:

```text
Implement feature X
+ rewrite subsystem Y
+ reorganize the project
+ replace dependency Z
+ clean up unrelated files
```

Unrelated technical debt should not automatically become part of the current task.

If unrelated problems are discovered:

1. Record them.
2. Explain their impact.
3. Continue the current task if safe.
4. Address them only if they block the current work or the specification requires it.

---

# 8. No Unnecessary Rewrites

A working subsystem should not be rewritten simply because:

* Another implementation is more elegant
* Another framework is preferred
* A newer library exists
* The code could theoretically be cleaner
* A different pattern is fashionable
* The existing implementation is not aesthetically ideal

Default assumption:

> **Preserve working behavior unless there is a concrete reason to change it.**

Prefer incremental improvement over replacement.

---

# 9. AI vs Deterministic Logic

EverydayFuel should use AI where AI provides meaningful value and deterministic code where deterministic behavior is more reliable.

### AI should generally handle:

* Understanding natural-language input
* Food identification
* Interpreting ambiguous user input
* Extracting structured information
* Estimation where deterministic data is unavailable
* Semantic interpretation

### Deterministic code should generally handle:

* Arithmetic
* Macro calculations
* Proportional scaling
* Aggregation
* Totals
* Unit conversions where deterministic
* Database operations
* Validation
* Historical calculations
* Known-rule transformations

Do not move deterministic calculations into AI merely because the AI can perform them.

> **If it can be reliably calculated, calculate it in code.**

---

# 10. Local-First Principle

EverydayFuel is fundamentally local-first.

Do not introduce cloud infrastructure merely because it makes implementation easier.

Any external dependency or service must be evaluated for:

* Offline behavior
* Failure behavior
* Data privacy
* Latency
* Cost
* APK/runtime complexity
* Long-term maintainability

Core functionality should not unnecessarily depend on connectivity.

---

# 11. Dependency Discipline

Do not introduce dependencies without a concrete reason.

Before adding a dependency, determine:

* Why it is required
* Whether existing functionality can solve the problem
* Whether it increases APK size
* Whether it introduces native complexity
* Whether it affects offline operation
* Whether it creates licensing concerns
* Whether it creates additional maintenance burden

Prefer existing project capabilities when they are sufficient.

---

# 12. Data Integrity

User data takes priority over implementation convenience.

Be especially careful with:

* SQLite schema
* Migrations
* Historical nutrition records
* Training records
* User settings
* Goals
* Daily logs
* Calculated historical values
* IDs
* Relationships

Never casually:

* Delete historical data
* Overwrite historical data
* Reinterpret historical data
* Change identifiers
* Break relationships
* Introduce destructive migrations

If a change could invalidate existing user data, stop and explicitly analyze the consequences before proceeding.

---

# 13. Tool Failure ≠ Repository Failure

DeepSeek must distinguish between:

* File/path not found
* Permission denied
* Invalid encoding
* Tool invocation failure
* Upstream service failure
* Repository failure
* Build failure
* Test failure

Do not attribute a tool failure to the repository without evidence.

For example, if a directory listing successfully shows:

```text
Ai Guidelines/
    Agent Governance Rules.md
    Master Migration Build Specification.md
```

but a separate filesystem operation fails, the correct conclusion is **not automatically that the path is malformed**.

### Recovery rule

If one file-access method fails:

1. Verify whether the file was already discovered.
2. Try an appropriate alternative access method.
3. Do not repeatedly retry the exact same failed operation.
4. Distinguish tool/backend errors from filesystem errors.
5. Continue using another reliable method when possible.

After repeated failure of the same access method, change methods rather than burning the task on retries.

Do not invent explanations such as "special characters," "encoding problems," or "spaces in the path" without evidence.

---

# 14. Verification Is Mandatory

Never assume:

> "The code looks correct."

or:

> "The implementation should work."

Verification must follow implementation.

Required flow:

```text
IMPLEMENT
    ↓
BUILD
    ↓
TEST
    ↓
INVESTIGATE FAILURES
    ↓
FIX
    ↓
BUILD AGAIN
    ↓
TEST AGAIN
    ↓
INSPECT DIFF
    ↓
FINAL REPORT
```

If tests cannot be run, state that explicitly.

Never claim successful validation when validation was not performed.

---

# 15. Git Discipline

Every meaningful work package should produce a coherent Git checkpoint when appropriate.

Before committing:

1. Build the project.
2. Run relevant tests.
3. Inspect the diff.
4. Check for accidental changes.
5. Confirm the implementation is coherent.
6. Document known unresolved issues.

Do not knowingly commit broken code without documenting why it is temporarily broken.

Prefer focused commits over giant collections of unrelated changes.

### Committing cadence (user confirmation, pass 13)

**The user has explicitly authorized the agent to commit and push its own work, but only AFTER the user confirms** (added 2026-08-20, pass 13). The workflow is:

1. Finish the work package.
2. Build, run tests, inspect the diff, fix issues — per §15 above.
3. **Pause and report: summarize what changed, what was verified, and what the commit would be. Wait for the user's explicit go-ahead.**
4. Only after the user confirms: commit with a clear, self-written message in the repository's existing style (`feat(scope): ...` / `fix(scope): ...`), then push to `origin` (branch `main`).
5. Record each commit's hash in the pass's AI work log and in `HANDOVER.md` so the next pass knows the exact checkpoint.

This replaces any earlier "leave the tree uncommitted for the user" convention. The §15 build/test/diff pre-checks still apply before every commit.

---

# 16. Preserve Existing Contracts

Existing interfaces and contracts should be treated as stable.

Before changing an interface, determine:

* Who consumes it?
* What data does it provide?
* What assumptions depend on it?
* Does changing it affect persistence?
* Does it affect native integration?
* Does it affect the UI?
* Does it affect AI integration?
* Does it require migration?

Do not change interfaces casually.

---

# 17. Do Not Create Work for the Sake of Work

DeepSeek must not modify code merely because it has:

* Available context
* Remaining tokens
* Available time
* Available tool calls

A task is complete when:

* Requested functionality works
* Integration is complete
* Relevant tests pass
* Build succeeds
* Implementation is coherent
* No known critical issue remains

Do not continue modifying unrelated code after completion.

> **An idle agent is better than unnecessary code.**

---

# 18. Documentation and AI Logs

The `Ai Guidelines` directory contains important project context.

Before substantial implementation, DeepSeek should consult the relevant:

* Governance rules
* Master Migration / Build Specification
* AI logs
* Previous implementation decisions
* Known issues

AI logs are historical context, not automatically authoritative instructions.

If an old AI log conflicts with the current specification or actual implementation:

> **Current specification + actual repository > historical AI log.**

Do not blindly reproduce an old agent's implementation merely because it appears in a log.

---

# 19. Definition of Done

A work package is complete when:

* [ ] Requested functionality is implemented
* [ ] Existing functionality remains intact
* [ ] Relevant tests pass
* [ ] Build succeeds
* [ ] Relevant errors are resolved
* [ ] Diff has been inspected
* [ ] No unrelated changes were introduced
* [ ] Known limitations are documented
* [ ] Architectural boundaries were respected
* [ ] Data integrity was preserved
* [ ] Git checkpoint is created when appropriate

---

# 20. Final Operating Model

EverydayFuel currently uses **one active coding agent**.

```text
┌──────────────────────────────────┐
│          DEEPSEEK V4 FLASH       │
│                                  │
│  READ SPECIFICATION              │
│  READ AI GUIDELINES              │
│  READ RELEVANT AI LOGS           │
│  INSPECT ACTUAL REPOSITORY       │
│              ↓                   │
│  PLAN LOCALLY                    │
│              ↓                   │
│  IMPLEMENT                       │
│              ↓                   │
│  BUILD                           │
│              ↓                   │
│  TEST                            │
│              ↓                   │
│  FIX FAILURES                    │
│              ↓                   │
│  BUILD + TEST AGAIN              │
│              ↓                   │
│  INSPECT DIFF                    │
│              ↓                   │
│  REPORT RESULT                   │
└──────────────────────────────────┘
```

## Fundamental Rule

### DeepSeek builds. The repository and specification constrain it. Tests validate it.

DeepSeek must not independently redesign EverydayFuel without a concrete architectural requirement.

The goal is not maximum code output.

The goal is a **stable, coherent, maintainable EverydayFuel codebase that faithfully implements its established architecture without unnecessary drift.**

