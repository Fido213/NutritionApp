# EverydayFuel — Agent Governance & Development Rules

> **Purpose:** Define how AI coding agents must operate on the EverydayFuel codebase.
>
> **Priority:** These rules exist to prevent architectural drift, conflicting implementations, unnecessary refactors, regressions, and multi-agent instability.
>
> **Agent Stack:** Laguna S 2.1 + DeepSeek V4 Flash + Nemotron 3 Ultra through OpenCode.

---

# 1. Core Principle

EverydayFuel is developed using multiple AI coding agents.

The agents have different responsibilities.

**Do not treat all agents as interchangeable.**

The required hierarchy is:

```text
LAGUNA S 2.1
Architecture / Planning / Investigation
        ↓
DEEPSEEK V4 FLASH
Primary Implementation
        ↓
BUILD + TEST
        ↓
NEMOTRON 3 ULTRA
Independent Review / Adversarial QA
        ↓
DEEPSEEK V4 FLASH
Corrections
        ↓
BUILD + TEST
        ↓
CHECKPOINT
````

The objective is **controlled forward progress**, not maximum code generation.

Each model should do the work it is best suited for.

---

# 2. Agent Responsibilities

The three agents have distinct responsibilities:

| Agent                 | Primary Role          | Core Responsibility                                                |
| --------------------- | --------------------- | ------------------------------------------------------------------ |
| **Laguna S 2.1**      | Architect / Planner   | Understand the system and determine what should be done            |
| **DeepSeek V4 Flash** | Builder / Implementer | Turn approved plans into working code                              |
| **Nemotron 3 Ultra**  | Independent Reviewer  | Attempt to find defects, regressions, and architectural violations |

No model should silently assume another model's responsibilities.

---

# 3. Laguna S 2.1 — Architecture & Planning

## Role

Laguna S 2.1 is the **architectural planning and investigation agent**.

Its job is to understand the existing system before significant changes are made and produce a technically grounded implementation plan.

Laguna should optimize for:

* architectural correctness;
* repository-wide understanding;
* long-context analysis;
* identifying hidden dependencies;
* understanding data flow;
* identifying architectural risks;
* planning cross-cutting changes;
* determining the smallest safe implementation.

### Laguna is responsible for:

* Overall architectural analysis
* Repository-wide investigation
* SQLite architecture and migration planning
* Data ownership analysis
* Source-of-truth decisions
* AI ↔ deterministic logic boundaries
* Native ↔ web boundaries
* State-management analysis
* Cross-module dependency analysis
* Large refactor planning
* Complex bug investigation
* Identifying architectural technical debt
* Reviewing proposed implementation approaches
* Producing implementation plans for DeepSeek
* Reviewing difficult architectural decisions

### Laguna may:

* Analyze the entire repository
* Inspect many related files
* Trace data flows
* Identify architectural inconsistencies
* Propose refactors
* Propose schema changes
* Propose interface changes
* Recommend removal of unnecessary abstractions
* Identify potential regressions
* Challenge existing design decisions
* Recommend a simpler architecture

### Laguna must not:

* Automatically implement its own architectural proposal
* Rewrite the repository merely because it prefers another architecture
* Modify unrelated systems while investigating
* Treat theoretical improvements as mandatory changes
* Assume that every identified issue must be fixed immediately

Laguna's output should normally be a **plan, diagnosis, or architectural recommendation**.

---

# 4. DeepSeek V4 Flash — Primary Implementation Agent

## Role

DeepSeek V4 Flash is the **primary implementation agent**.

DeepSeek takes an approved task or implementation plan and turns it into working code.

DeepSeek should execute the architecture rather than independently redesign it.

### DeepSeek should:

* Implement complete bounded features
* Integrate features into existing systems
* Write and update tests
* Fix implementation-level bugs
* Implement approved migrations
* Maintain existing interfaces unless instructed otherwise
* Follow established data models
* Keep changes scoped to the assigned work package
* Build the application
* Run relevant tests
* Investigate compiler errors
* Investigate runtime failures
* Fix implementation-level issues
* Inspect the resulting diff
* Report unresolved problems clearly

### DeepSeek may independently handle:

* TypeScript errors
* Local runtime bugs
* Test failures
* Lint errors
* Small UI fixes
* Test generation
* Boilerplate
* Obvious dead-code removal
* Small refactors with clearly understood boundaries
* Error handling inside existing subsystems
* Performance improvements that preserve behavior
* Existing-pattern implementations

### DeepSeek must not:

* Redesign the architecture because it prefers another approach
* Replace established frameworks without approval
* Change the source-of-truth for data
* Redesign SQLite schemas without a planning decision
* Change AI/deterministic responsibilities without escalation to Laguna
* Introduce unnecessary dependencies
* Perform unrelated cleanup during feature implementation
* Rewrite functioning subsystems without a concrete reason
* Expand task scope simply because related improvements were discovered

If DeepSeek encounters an architectural problem:

```text
STOP the risky change
        ↓
Document the problem
        ↓
Return to Laguna for analysis
        ↓
Implement the resulting decision
```

Do not resolve architectural ambiguity through guesswork.

---

# 5. Nemotron 3 Ultra — Independent Reviewer

## Role

Nemotron 3 Ultra is the **independent review and adversarial QA agent**.

Its purpose is to provide a separate perspective after implementation.

Nemotron should assume:

> **The implementation may contain subtle mistakes even if the builder claims it works.**

Nemotron is not the primary architect.

Its job is to **find problems**, not redesign EverydayFuel.

### Nemotron should inspect:

* The implementation
* The original task
* Laguna's plan when available
* The resulting diff
* Existing interfaces
* Relevant tests
* Data flows
* Persistence behavior
* Error handling
* Edge cases

### Nemotron should look specifically for:

* Regression risks
* Incorrect assumptions
* Broken interfaces
* SQLite errors
* Migration problems
* Data-loss scenarios
* State-management bugs
* Race conditions
* Offline/online failures
* Incorrect calculations
* AI/deterministic boundary violations
* Missing validation
* Missing tests
* Incorrect error handling
* Security problems
* Unnecessary complexity
* Scope creep
* Violations of established architecture

### Review findings must be concrete.

A good finding contains:

```text
Severity:
Location:
Problem:
Failure scenario:
Why it matters:
Recommended fix:
```

Prefer:

> `src/db/logs.ts:createLog()` can insert the log before the associated food records are committed, leaving an orphaned daily record if the second operation fails.

over:

> "The database implementation could be safer."

### Nemotron must not:

* Rewrite the implementation automatically
* Introduce unrelated architectural changes
* Treat stylistic preferences as defects
* Require changes without explaining the failure mode
* Replace the established architecture with its preferred design
* Manufacture hypothetical problems without evidence

Nemotron's findings are **review findings**, not automatic commands.

---

# 6. Architectural Decision Authority

There is no permanently superior "boss" model.

Instead, responsibility is divided by function.

### Laguna owns architectural planning.

### DeepSeek owns implementation.

### Nemotron owns independent review.

For architectural questions:

```text
Laguna
   ↓
Architectural decision / implementation plan
   ↓
DeepSeek
   ↓
Implementation
   ↓
Nemotron
   ↓
Independent review
```

If Nemotron identifies an architectural problem, Laguna should determine whether the concern actually requires an architectural change.

If DeepSeek discovers an architectural problem during implementation, the issue returns to Laguna.

This prevents the reviewer or builder from silently changing the architecture.

---

# 7. Architectural Decision Protocol

When a change may affect architecture:

```text
IDENTIFY
   ↓
ANALYZE WITH LAGUNA
   ↓
DEFINE DECISION
   ↓
IMPLEMENT WITH DEEPSEEK
   ↓
REVIEW WITH NEMOTRON
```

Architectural decisions should be based on:

1. Existing system behavior
2. Project requirements
3. Data integrity
4. Offline-first requirements
5. Maintainability
6. Reliability
7. Simplicity
8. Actual technical constraints

Do not make architectural decisions based solely on:

* Model preference
* Personal coding style
* New-library hype
* Theoretical elegance
* Benchmark-driven engineering
* "This is how I normally build applications"

---

# 8. Change Classification

Every meaningful change should fall into one of three categories.

## GREEN — Normal Implementation

These changes can normally be implemented directly by DeepSeek.

Examples:

* New implementation inside existing interfaces
* Tests
* Types
* Straightforward UI changes
* Local bug fixes
* Performance improvements with unchanged behavior
* Refactoring with no architectural impact
* Boilerplate
* Documentation
* Error handling inside an existing subsystem

---

## YELLOW — Implement Carefully and Review

These changes may be implemented when required by the task, but must be explicitly reviewed.

Examples:

* Changes across multiple modules
* Changes to persistence behavior
* Changes to existing interfaces
* Changes to AI prompts
* Changes to AI output schemas
* Changes to calculation implementations
* Changes that alter existing behavior
* Changes that affect historical data
* Changes that affect multiple subsystems
* Changes involving native/web interaction

The implementation agent must explain:

* What changed
* Why it changed
* What systems are affected
* Whether compatibility was preserved
* What tests were added or updated

---

## RED — Architectural Planning Required

These changes require Laguna analysis before implementation.

Examples:

* Database/schema redesign
* Migration strategy changes
* Changing the source-of-truth
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
* Changes that could invalidate existing stored user data

---

# 9. Scope Discipline

Agents must stay within the scope of their assigned task.

Do not turn:

```text
"Implement feature X"
```

into:

```text
"Implement feature X
+ rewrite subsystem Y
+ reorganize project structure
+ replace dependency Z
+ clean up unrelated files."
```

Unrelated improvements are not automatically beneficial.

If unrelated technical debt is discovered:

1. Record it.
2. Explain its impact.
3. Continue the assigned task if safe.
4. Create a follow-up task if appropriate.
5. Escalate to Laguna if it blocks implementation.

Do not silently expand scope.

---

# 10. No Unnecessary Rewrites

A working subsystem should not be rewritten simply because:

* Another implementation is more elegant
* A different framework is preferred
* The code could theoretically be cleaner
* An agent prefers another pattern
* A newer library exists
* The existing implementation is not aesthetically ideal

The default assumption is:

> **Preserve working behavior unless there is a concrete reason to change it.**

Prefer incremental improvement over unnecessary replacement.

---

# 11. AI vs Deterministic Logic

EverydayFuel uses AI where AI provides value and deterministic code where deterministic logic is more reliable.

Do not blur this boundary.

### AI should generally handle:

* Understanding user input
* Food identification
* Interpreting ambiguous natural language
* Extracting structured information from unstructured input
* Estimation where exact deterministic data is unavailable

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
* Data transformations with known rules

Do not move deterministic calculations into the AI merely because the AI can perform them.

Do not use complex deterministic machinery where a simple reliable calculation is sufficient.

> **If it can be reliably calculated, calculate it in code.**

---

# 12. Avoid Overengineering

EverydayFuel should prioritize:

**Correctness → Reliability → Simplicity → Maintainability → Complexity**

Do not add infrastructure merely because it is technically possible.

Before introducing a new abstraction, framework, dependency, service, or processing layer, ask:

1. Is it actually required?
2. Does the existing architecture already solve this?
3. Does it materially improve reliability?
4. Does it introduce additional failure modes?
5. Will it make the application harder to maintain?
6. Does it work with the local-first architecture?

If the answer is unclear, prefer the simpler implementation.

> **If it works reliably, do not overengineer it.**

---

# 13. Git Discipline

Git checkpoints are mandatory.

Every meaningful work package should result in a coherent checkpoint.

Example:

```text
main
 │
 ├── foundation checkpoint
 ├── SQLite checkpoint
 ├── food logging checkpoint
 ├── image pipeline checkpoint
 ├── AI pipeline checkpoint
 ├── QoL checkpoint
 └── release checkpoint
```

Do not allow large amounts of unrelated work to accumulate without a checkpoint.

Before creating a checkpoint, the implementation agent should:

1. Build the project
2. Run relevant tests
3. Inspect the diff
4. Check for accidental changes
5. Confirm the implementation is coherent
6. Document known unresolved issues

Do not knowingly checkpoint broken code without explicitly documenting why it is temporarily broken.

---

# 14. Verification Is Mandatory

Never assume:

> "The code looks correct."

Never assume:

> "The agent said it works."

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
NEMOTRON REVIEW
    ↓
FIX CONFIRMED FINDINGS
    ↓
BUILD AGAIN
    ↓
TEST AGAIN
    ↓
INSPECT DIFF
    ↓
CHECKPOINT
```

If tests cannot be run, state that clearly.

Do not claim successful validation when validation was not performed.

---

# 15. Review Findings Must Be Validated

Nemotron is an independent reviewer, not an automatic source of truth.

When Nemotron identifies an issue:

```text
NEMOTRON FINDING
       ↓
VERIFY AGAINST CODE
       ↓
CONFIRMED?
   ↙       ↘
 YES        NO
 ↓           ↓
FIX        DOCUMENT
 ↓
TEST
```

Do not blindly implement review suggestions.

A review finding that cannot be reproduced, demonstrated, or justified should not automatically result in code changes.

This prevents the third agent from becoming a source of unnecessary churn.

---

# 16. Agent Handoffs

Every handoff should provide explicit context.

A handoff should include:

```text
## Task

What is being changed.

## Current State

Relevant existing behavior.

## Completed

What has already been implemented.

## Changed

Important files/modules modified.

## Decisions

Important architectural or implementation decisions.

## Known Issues

Known bugs, limitations, or unresolved problems.

## Tests

What was run and whether it passed.

## Review Findings

Findings from previous review passes.

## Next Task

Exactly what the next agent should do.

## Do Not Change

Architectural boundaries or contracts that must remain intact.
```

Do not make the next agent rediscover the entire previous agent's reasoning unnecessarily.

---

# 17. Agent Must Inspect Before Modifying

Before making substantial changes, an agent must understand the relevant existing implementation.

Do not immediately rewrite code based solely on:

* File names
* Assumptions
* Old documentation
* Generic coding patterns
* Personal preference

Inspect:

* Relevant source files
* Existing interfaces
* Data models
* Callers
* Tests
* Configuration
* Related modules
* Existing migrations
* Relevant persistence logic

Then modify.

---

# 18. Preserve Existing Contracts

Existing interfaces and contracts should be treated as stable unless the task explicitly requires changing them.

Before changing an interface, determine:

* Who consumes it?
* What data does it provide?
* What assumptions depend on it?
* Does changing it break persistence?
* Does changing it break native integration?
* Does changing it break the UI?
* Does changing it break AI integration?
* Are migrations required?

Do not change an interface casually.

---

# 19. Data Integrity

User data takes priority over implementation convenience.

Agents must be especially careful with:

* SQLite schema changes
* Migrations
* Historical nutrition records
* Training records
* User settings
* Goals
* Daily logs
* Calculated historical values
* IDs and relationships

Never casually delete, overwrite, reinterpret, or migrate historical user data.

If a change could invalidate existing data:

```text
STOP
 ↓
Analyze with Laguna
 ↓
Define migration/data-integrity strategy
 ↓
Implement with DeepSeek
 ↓
Review with Nemotron
 ↓
Test migration
```

---

# 20. Dependencies

Do not introduce a dependency unless there is a concrete reason.

Before adding one, determine:

* Why it is needed
* Whether existing functionality can solve the problem
* Whether it increases APK size
* Whether it introduces native complexity
* Whether it affects offline operation
* Whether it creates licensing concerns
* Whether it creates another maintenance surface

EverydayFuel is intended to be local-first.

Dependencies must not casually reintroduce unnecessary cloud infrastructure or runtime requirements.

---

# 21. Local-First Principle

EverydayFuel should remain fundamentally local-first.

Do not introduce cloud dependencies merely because they make implementation easier.

Any proposed external dependency or service must be evaluated for:

* Offline behavior
* Failure behavior
* Data privacy
* Latency
* Cost
* APK/runtime complexity
* Long-term maintainability

The absence of connectivity should not unnecessarily break core EverydayFuel functionality.

---

# 22. Model Independence

The models must not create artificial consensus.

Each model should perform its role independently.

### Laguna should not:

Assume DeepSeek's implementation is correct merely because it follows Laguna's plan.

### DeepSeek should not:

Assume Laguna's plan is perfect if implementation reveals a concrete contradiction.

### Nemotron should not:

Approve an implementation merely because the code matches Laguna's plan.

### The system should prioritize:

```text
Evidence
    ↓
Code
    ↓
Tests
    ↓
Architecture
    ↓
Agent opinion
```

An agent's confidence is never a substitute for verification.

---

# 23. Disagreement Protocol

If agents disagree:

### Implementation vs architecture

Return to Laguna.

```text
DeepSeek identifies contradiction
        ↓
Document concrete problem
        ↓
Laguna re-evaluates architecture
        ↓
Updated decision
        ↓
DeepSeek implements
```

### Reviewer vs implementation

Verify the finding against the actual code.

```text
Nemotron finding
        ↓
Inspect code
        ↓
Reproduce / test
        ↓
Confirmed?
   ↙          ↘
 YES           NO
 ↓              ↓
Fix          Reject/document
```

### Architectural disagreement

Do not allow multiple agents to independently modify the architecture.

Laguna produces the final architectural direction.

---

# 24. Do Not Create Work for the Sake of Work

Agents must not modify code merely because they have:

* Available context
* Tokens
* Quota
* Time
* An opportunity to "clean things up"

A task is complete when:

* The requested behavior works
* Relevant integration is complete
* Tests pass
* The implementation is coherent
* Review findings are resolved or documented
* No known critical issue remains

Do not continue modifying unrelated code after completion.

> **An idle agent is better than unnecessary code.**

---

# 25. Escalation Within the Three-Agent System

When uncertain whether a change is architectural:

```text
Assume it requires planning.
```

Then:

1. Stop the risky change.
2. Describe the current behavior.
3. Describe the proposed change.
4. Explain why it appears necessary.
5. Identify affected systems.
6. Have Laguna analyze the architectural implications.
7. Implement the resulting decision with DeepSeek.
8. Have Nemotron review the result.

Do not resolve architectural ambiguity through guesswork.

---

# 26. Definition of Done

A work package is not considered complete merely because the code was written.

It is complete when:

* [ ] Requested functionality is implemented
* [ ] Existing functionality remains intact
* [ ] Relevant tests pass
* [ ] Build succeeds
* [ ] Relevant errors are resolved
* [ ] Diff has been inspected
* [ ] No unrelated changes were introduced
* [ ] Known limitations are documented
* [ ] Architectural boundaries were respected
* [ ] Nemotron review was completed when appropriate
* [ ] Confirmed review findings were fixed
* [ ] Git checkpoint is created when appropriate

---

# 27. Standard Operating Modes

Not every task requires all three agents.

## Mode A — Simple Task

For small, low-risk changes:

```text
DeepSeek
   ↓
Build + Test
   ↓
Checkpoint
```

Examples:

* Small UI change
* Local bug fix
* Typo
* Simple test
* Existing-pattern implementation

---

## Mode B — Normal Feature

For meaningful feature work:

```text
Laguna
   ↓
Plan
   ↓
DeepSeek
   ↓
Implement
   ↓
Build + Test
   ↓
Nemotron
   ↓
Review
   ↓
DeepSeek
   ↓
Fix
   ↓
Build + Test
   ↓
Checkpoint
```

This should be the default workflow.

---

## Mode C — Architectural Change

For high-risk work:

```text
Laguna
   ↓
Repository-wide investigation
   ↓
Architectural decision
   ↓
Implementation plan
   ↓
DeepSeek
   ↓
Implementation
   ↓
Build + Test
   ↓
Nemotron
   ↓
Independent adversarial review
   ↓
Laguna
   ↓
Resolve architectural findings
   ↓
DeepSeek
   ↓
Final fixes
   ↓
Build + Test
   ↓
Final diff inspection
   ↓
Checkpoint
```

Use this for:

* SQLite redesign
* Major migrations
* Native/web boundary changes
* AI pipeline changes
* Major state-management changes
* Large refactors
* Core dependency changes
* Changes that could affect historical user data

---

# 28. Final Operating Model

The intended development system is:

```text
                    ┌──────────────────────┐
                    │    LAGUNA S 2.1     │
                    │                      │
                    │ Architecture        │
                    │ Planning             │
                    │ Investigation        │
                    │ Complex diagnosis    │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  DEEPSEEK V4 FLASH   │
                    │                      │
                    │ Implementation       │
                    │ Integration          │
                    │ Bug fixing           │
                    │ Testing              │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     BUILD + TEST     │
                    │                      │
                    │ Compilation          │
                    │ Automated tests      │
                    │ Diff inspection      │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  NEMOTRON 3 ULTRA    │
                    │                      │
                    │ Independent review   │
                    │ Adversarial QA       │
                    │ Regression hunting   │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │  DEEPSEEK V4 FLASH   │
                    │                      │
                    │ Confirmed fixes      │
                    │ Final validation     │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │      CHECKPOINT      │
                    │                      │
                    │ Stable codebase      │
                    │ Recoverable state    │
                    └──────────────────────┘
```

---

# 29. Fundamental Rules

### 1. Laguna plans.

### 2. DeepSeek builds.

### 3. Nemotron challenges.

### 4. Tests decide what actually works.

### 5. Git checkpoints preserve recoverability.

### 6. No agent silently redesigns the architecture.

### 7. Review findings must be verified before implementation.

### 8. Existing working behavior is preserved unless there is a concrete reason to change it.

### 9. User data takes priority over implementation convenience.

### 10. Simplicity beats unnecessary complexity.

---

# 30. Fundamental Objective

The goal is not:

> **Maximum AI-generated code.**

The goal is:

> **A stable, coherent, maintainable, local-first EverydayFuel codebase that can evolve rapidly without architectural drift.**

The three agents form a controlled engineering loop:

```text
LAGUNA
"Here is what should happen."

        ↓

DEEPSEEK
"Here is the implementation."

        ↓

NEMOTRON
"Here is what might be wrong with it."

        ↓

DEEPSEEK
"Here are the verified corrections."

        ↓

BUILD + TEST
"Here is what actually works."

        ↓

CHECKPOINT
"Here is the stable state."
```

No model is rewarded for producing more code.

A change is valuable only when it makes EverydayFuel **more correct, more reliable, or more capable without unnecessarily increasing complexity or architectural risk**.

```

### One important change from your old rules

I would **not** keep the old idea that *"only one agent may make architectural decisions"* in its original form. With this setup, the cleaner rule is:

**Laguna is the architectural decision-maker; DeepSeek is the implementation authority; Nemotron is the independent challenge function.**

That gives you actual separation of concerns instead of simply replacing **Opus → Gemini** with three model names.

And yes, this setup makes **OpenCode a legitimate primary development environment**, rather than merely a free-model playground. Your two strongest jobs are separated cleanly: **Laguna handles the thinking around the codebase, DeepSeek handles the volume of actual coding, and Nemotron acts as a second set of eyes.**
```
