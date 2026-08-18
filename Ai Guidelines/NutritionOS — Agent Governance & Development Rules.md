# NutritionOS — Agent Governance & Development Rules

> **Purpose:** Define how AI coding agents must operate on the NutritionOS codebase.
>
> **Priority:** These rules exist to prevent architectural drift, conflicting implementations, unnecessary refactors, and multi-agent instability.

---

# 1. Core Principle

NutritionOS is developed using multiple AI agents.

The agents have different responsibilities.

**Do not treat all agents as interchangeable.**

The required hierarchy is:

```text
OPUS
Architectural authority
      ↓
GEMINI
Primary implementation agent
      ↓
BUILD + TEST
      ↓
OPUS
Architectural review
```

The objective is **controlled forward progress**, not continuous modification of the codebase.

---

# 2. Architectural Authority

## Opus

Opus is the **architectural authority**.

Only Opus should make or approve major architectural decisions.

Opus is responsible for:

- Overall architecture
- SQLite schema and migrations
- Data ownership and source-of-truth decisions
- AI ↔ deterministic logic boundaries
- Native ↔ web boundaries
- Major refactors
- Security and data-integrity decisions
- Resolving architectural technical debt
- Deciding major implementation phases
- Reviewing completed subsystems
- Resolving disagreements between implementation approaches

### Opus may change architecture.

However, Opus must avoid unnecessary architectural changes when the existing design is already adequate.

**Opus may refactor working systems when it is deemed necessary.**

---

# 3. Gemini's Role

## Gemini

Gemini is the **primary implementation agent**.

Gemini should implement clearly defined work packages according to:

1. The existing architecture
2. The project specification
3. Existing interfaces and contracts
4. Explicit instructions from the current task
5. Decisions made by Opus

Gemini should **execute the architecture, not independently redesign it.**

### Gemini should:

- Implement complete bounded features
- Integrate features into existing systems
- Write and update tests
- Fix implementation-level bugs
- Maintain existing interfaces unless instructed otherwise
- Follow established data models
- Keep changes scoped to the assigned work package
- Build and validate after implementation
- Report unresolved problems clearly

### Gemini may:
- Finding errors
- Investigating compiler errors
- Fixing isolated TypeScript errors
- Fixing isolated runtime bugs
- Running tests
- Investigating failed tests
- Lint fixes
- Small UI fixes
- Test generation
- Repetitive boilerplate
- Obvious dead-code removal
- Small refactors with clearly understood boundaries
- Locating existing implementations

### Gemini must not:

- Redesign the architecture because it prefers another approach
- Replace established frameworks without approval
- Change the source-of-truth for data
- Redesign SQLite schemas without escalation
- Change AI/deterministic responsibilities without escalation
- Introduce unnecessary dependencies
- Perform unrelated cleanup during a feature implementation
- "Improve" unrelated parts of the application
- Rewrite functioning subsystems without a concrete reason

If Gemini encounters an architectural problem, **it should surface it clearly and continue implementation where safe; architectural refinement is handled in the Opus review loop, where Opus (Claude) stabilizes, corrects, and establishes the codebase while Gemini continues rapid development in parallel.**

# 5. Single Architectural Decision Maker

At any given time:

> **Only one agent may make architectural decisions.**

That agent is **Opus**.

Gemini may:

- Identify architectural problems
- Explain consequences
- Propose alternatives
- Flag technical debt

They must not silently implement architectural changes.

If an implementation requires an architectural decision:

```text
STOP
 ↓
Describe the problem
 ↓
Describe the affected systems
 ↓
Describe possible solutions
 ↓
Escalate to Opus
```

---

# 6. Change Classification

Every meaningful change should fall into one of three categories.

## GREEN — Normal Implementation

These changes can normally be implemented without architectural escalation:

- New implementation inside existing interfaces
- Tests
- Types
- Straightforward UI changes
- Local bug fixes
- Performance improvements with unchanged behavior
- Refactoring with no architectural impact
- Boilerplate
- Documentation
- Error handling within an existing subsystem

---

## YELLOW — Implement Carefully and Report

These changes may be implemented if required by the assigned task, but must be explicitly reported:

- Changes across multiple modules
- Changes to persistence behavior
- Changes to existing interfaces
- Changes to AI prompts
- Changes to AI output schemas
- Changes to calculation implementations
- Changes that alter existing behavior
- Changes that affect historical data
- Changes that affect multiple subsystems

The agent must explain:

- What changed
- Why it changed
- What systems are affected
- Whether compatibility was preserved

---

## RED — Architectural Escalation Required

Do not implement these independently.

Escalate to Opus before proceeding:

- Database/schema redesign
- Migration strategy changes
- Changing the source-of-truth
- Changing data ownership
- Changing historical-data semantics
- Changing AI ↔ deterministic responsibilities
- Major state-management changes
- Major native ↔ web architecture changes
- Removing major subsystems
- Introducing a major framework/runtime
- Replacing a core dependency
- Large-scale refactors
- Security architecture changes
- Changes that could invalidate existing stored user data

---

# 7. Scope Discipline

Agents must stay within the scope of their assigned task.

Do not turn:

```text
"Implement feature X"
```

into:

```text
"Implement feature X + rewrite subsystem Y + reorganize project structure +
replace dependency Z + clean up unrelated files."
```

Unrelated improvements are **not automatically beneficial**.

If unrelated technical debt is discovered:

1. Record it.
2. Explain its impact.
3. Continue the assigned task if safe.
4. Escalate if it blocks implementation.

Do not silently expand scope.

---

# 8. No Unnecessary Rewrites

A working subsystem should not be rewritten simply because:

- Another implementation is more elegant
- A different framework is preferred
- The code could theoretically be cleaner
- The agent personally prefers another pattern
- A newer library exists
- The existing implementation is not aesthetically ideal

The default assumption is:

> **Preserve working behavior unless there is a concrete reason to change it.**

Prefer incremental improvement over unnecessary replacement.

---

# 9. AI vs Deterministic Logic

NutritionOS uses AI where AI provides value and deterministic code where deterministic logic is more reliable.

Do not blur this boundary.

### AI should generally handle:

- Understanding user input
- Food identification
- Interpreting ambiguous natural language
- Extracting structured information from unstructured input
- Estimation where exact deterministic data is unavailable

### Deterministic code should generally handle:

- Arithmetic
- Macro calculations
- Proportional scaling
- Aggregation
- Totals
- Unit conversions where deterministic
- Database operations
- Validation
- Historical calculations
- Data transformations with known rules

Do not move deterministic calculations into the AI merely because the AI can perform them.

Do not use complex deterministic machinery where a simple reliable calculation is sufficient.

**If it can be reliably calculated, calculate it in code.**

---

# 10. Avoid Overengineering

NutritionOS should prioritize:

**Correctness → Reliability → Simplicity → Maintainability → Complexity**

Do not add infrastructure merely because it is technically possible.

Before introducing a new abstraction, framework, dependency, service, or processing layer, ask:

1. Is it actually required?
2. Does the existing architecture already solve this?
3. Does it materially improve reliability?
4. Does it introduce additional failure modes?
5. Will it make the application harder to maintain?

If the answer is unclear, prefer the simpler implementation.

> **If it works reliably, do not overengineer it.**

---

# 11. Git Discipline

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
 ├── QoL checkpoint
 └── release checkpoint
```

Do not allow large amounts of unrelated work to accumulate without a checkpoint.

Before committing, the implementing agent should:

1. Build the project
2. Run relevant tests
3. Inspect the diff
4. Check for accidental changes
5. Confirm the implementation is coherent
6. Document known unresolved issues

Do not knowingly commit broken code without explicitly documenting why it is temporarily broken.

---

# 12. Verification Is Mandatory

Never assume:

> "The code looks correct."

or:

> "The agent said it works."

Verification should follow implementation.

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
CHECKPOINT
```

If tests cannot be run, the agent must state that clearly.

Do not claim successful validation when validation was not performed.

---

# 13. Agent Handoffs

When handing work to another agent, provide explicit context.

A handoff should include:

```text
## Completed

What was implemented.

## Changed

Important files/modules modified.

## Decisions

Important implementation decisions.

## Known Issues

Known bugs, limitations, or unresolved problems.

## Tests

What was run and whether it passed.

## Next Task

Exactly what the next agent should do.

## Architectural Notes

Anything the next agent must not change.
```

Do not make the next agent rediscover the entire previous agent's reasoning unnecessarily.

---

# 14. Agent Must Inspect Before Modifying

Before making substantial changes, an agent must understand the relevant existing implementation.

Do not immediately rewrite code based solely on:

- File names
- Assumptions
- Old documentation
- Generic coding patterns
- Personal preference

Inspect:

- Relevant source files
- Existing interfaces
- Data models
- Callers
- Tests
- Configuration
- Related modules

Then modify.

---

# 15. Preserve Existing Contracts

Existing interfaces and contracts should be treated as stable unless the task explicitly requires changing them.

Before changing an interface, determine:

- Who consumes it?
- What data does it provide?
- What assumptions depend on it?
- Does changing it break persistence?
- Does changing it break native integration?
- Does changing it break the UI?
- Does changing it break AI integration?
- Are migrations required?

Do not change an interface casually.

---

# 16. Data Integrity

User data takes priority over implementation convenience.

Agents must be especially careful with:

- SQLite schema changes
- Migrations
- Historical nutrition records
- Training records
- User settings
- Goals
- Daily logs
- Calculated historical values
- IDs and relationships

Never casually delete, overwrite, reinterpret, or migrate historical user data.

If a change could invalidate existing data:

**Escalate to Opus before implementation.**

---

# 17. Dependencies

Do not introduce a dependency unless there is a concrete reason.

Before adding one, determine:

- Why it is needed
- Whether existing functionality can solve the problem
- Whether it increases APK size
- Whether it introduces native complexity
- Whether it affects offline operation
- Whether it creates licensing concerns
- Whether it creates another maintenance surface

NutritionOS is intended to be local-first.

Dependencies must not casually reintroduce unnecessary cloud infrastructure or runtime requirements.

---

# 18. Local-First Principle

NutritionOS should remain fundamentally local-first.

Do not introduce cloud dependencies merely because they make implementation easier.

Any proposed external dependency or service must be evaluated for:

- Offline behavior
- Failure behavior
- Data privacy
- Latency
- Cost
- APK/runtime complexity
- Long-term maintainability

The absence of connectivity should not unnecessarily break core NutritionOS functionality.

---

# 19. Do Not Create Work for the Sake of Work

Agents must not modify code merely because they have available context, tokens, quota, or time.

A task is complete when:

- The requested behavior works
- Relevant integration is complete
- Tests pass
- The implementation is coherent
- No known critical issue remains

Do not continue modifying unrelated code after completion.

**An idle agent is better than unnecessary code.**

---

# 20. Escalation Protocol

When uncertain whether a change is architectural:

```text
Assume it is architectural.
```

Then:

1. Stop the risky change.
2. Describe the current behavior.
3. Describe the proposed change.
4. Explain why it appears necessary.
5. Identify affected systems.
6. Present alternatives if relevant.
7. Escalate to Opus.

Do not resolve architectural ambiguity through guesswork.

---

# 21. Definition of Done

A work package is not considered complete merely because the code was written.

It is complete when:

- [ ] Requested functionality is implemented
- [ ] Existing functionality remains intact
- [ ] Relevant tests pass
- [ ] Build succeeds
- [ ] Relevant errors are resolved
- [ ] Diff has been inspected
- [ ] No unrelated changes were introduced
- [ ] Known limitations are documented
- [ ] Architectural boundaries were respected
- [ ] Git checkpoint is created when appropriate

---

# 22. Final Operating Model

The intended development loop is:

```text
┌──────────────────────────────┐
│            OPUS              │
│  Architecture / Priorities   │
│  Review / Major Decisions    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│           GEMINI             │
│  Major Feature Implementation│
│  Integration / Testing       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│       BUILD + TEST           │
│       DIFF INSPECTION        │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│            OPUS              │
│       Review / Next Phase    │
└──────────────────────────────┘
```

## The fundamental rule

### This is a relay from one agent to the other, in sync

**Opus decides <-> Gemini builds. Tests validate. Git checkpoints preserve recoverability.**

No agent should independently redesign NutritionOS.

The goal is not maximum code output.

The goal is a **stable, coherent, maintainable NutritionOS that moves forward without architectural drift.**
