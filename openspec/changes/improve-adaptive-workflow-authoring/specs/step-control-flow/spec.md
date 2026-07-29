## MODIFIED Requirements

### Requirement: Conditions over known values
`when:` MUST accept one condition clause or a non-empty ordered list of clauses. A clause MUST be a whole-value template for truthiness, or a string that compares one whole-value template to a quoted string using `==` or `!=`. Lists MUST use short-circuit AND semantics in declaration order. Conditions MUST apply to every action. A false condition MUST mark the step skipped, let execution continue, and MUST NOT trigger recovery. The loader MUST reject shell commands, argv guards, arbitrary expressions, OR, parentheses, structured arrays or objects, and references to potentially absent values. For scalar truthiness, empty string, numeric zero, boolean false, and null MUST count as false. Every other scalar MUST count as true. Equality MUST compare the canonical text rendering of the scalar.

A result from a conditional step MUST remain absent when the producer is skipped. A consumer MAY reference that result only when every producer clause is present among the consumer's proven clauses. For a reference in a condition list, only earlier clauses are proven. The loader MUST reject unguarded, weaker, or out-of-order references and MUST perform no logical inference beyond structural clause equality.

#### Scenario: Platform condition
- **WHEN** `when:` is `'{{context.platform}} == "windows"'` on Linux
- **THEN** the step is recorded as skipped and the next step runs

#### Scenario: Ordered conjunction
- **WHEN** a step has two condition clauses and the first is false
- **THEN** the second clause is not evaluated and the step is skipped

#### Scenario: Arbitrary expression
- **WHEN** `when:` contains shell source, OR, parentheses, or another arbitrary expression
- **THEN** loading fails because v1alpha1 has no general expression language

#### Scenario: Guarded conditional result
- **WHEN** a producer and later consumer both include the same mode clause and the consumer references the producer result
- **THEN** loading succeeds and runtime evaluates the consumer only when the producer ran

#### Scenario: Weaker consumer guard
- **WHEN** a consumer references a conditional producer without including every producer clause
- **THEN** loading fails because the producer result is not proven available

#### Scenario: Out-of-order condition reference
- **WHEN** the first consumer clause references a conditional producer and a later clause would establish the producer guard
- **THEN** loading fails because later clauses cannot make an earlier read safe
