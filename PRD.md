# AI Landscape Verification Intelligence Platform

## Product Requirements Document (PRD)

**Version:** 1.0
**Status:** Ready for Implementation
**Implementation Target:** Claude Code
**Primary System:** Oracle NetSuite
**Primary User:** Photo Verification Team
**Team Lead:** Muriel

---

# 1. Executive Summary

The **AI Landscape Verification Intelligence Platform (ALVIP)** is an AI-assisted visual verification system designed to accelerate the review of landscape-service photographs associated with locations in Oracle NetSuite.

The current process requires reviewers to:

1. Log into the platform.
2. Locate the location queue.
3. Open one location.
4. Open and inspect pictures individually.
5. Determine whether required landscape services are visibly supported.
6. Record the verification decision.
7. Move to the next location.

The queue can contain **500+ locations per day**, with approximately **1–170 images per location**.

The platform will analyze images in batches at the **location level**, identify evidence supporting required landscape services, compare before/after images where available, detect contradictions and insufficient evidence, and present reviewers with a concise evidence package.

The system will **not initially replace human verification**.

Instead:

> **AI performs the heavy visual screening and evidence organization. Humans make final decisions for uncertain, risky, or insufficiently supported cases.**

The system should gradually introduce automation only after objective performance thresholds are demonstrated.

---

# 2. Problem Statement

The existing workflow is inefficient because verification occurs at the image level while the business decision is generally made at the **location/service level**.

A single location may contain up to 170 images and may require verification of multiple services.

The system must therefore answer:

> "Do the submitted images provide sufficient visual evidence that the required landscape services were performed?"

rather than simply:

> "What is visible in this image?"

The current verification categories include:

* Landscape maintenance
* Landscape fertilization
* Edging
* Mowing
* Weed removal
* Tree trimming/pruning
* Trash/debris/leaves removal
* Shrub pruning
* Dead/brown grass

A location may require one or multiple services depending on the client and scope.

---

# 3. Business Objectives

## Primary Objective

Reduce the amount of manual image-by-image inspection required to clear the daily location queue while maintaining or improving verification quality.

## Secondary Objectives

* Reduce reviewer time per location.
* Reduce unnecessary image inspection.
* Identify the strongest evidence automatically.
* Detect potentially incorrect approvals.
* Prioritize human attention toward uncertain cases.
* Provide transparent reasoning for AI-assisted decisions.
* Track queue progress in real time.
* Build an auditable history of AI and human decisions.
* Learn from reviewer feedback and historical notes.
* Support client-specific verification requirements.
* Eventually enable carefully controlled automation for high-confidence cases.

---

# 4. Success Definition

The business currently defines success primarily as:

> **Clearing the queue on a daily basis.**

The platform must therefore measure operational performance rather than only AI classification accuracy.

Primary KPIs:

### Queue KPIs

* Locations received per day
* Locations processed per day
* Locations remaining
* Queue clearance rate
* Average processing time per location
* Average processing time per image
* Oldest unprocessed location

### AI KPIs

* AI-human agreement rate
* Human override rate
* False approval rate
* False rejection rate
* AI confidence calibration
* Percentage of locations requiring human review
* Percentage of images successfully analyzed
* Image-quality failure rate

### Efficiency KPIs

* Average images manually reviewed per location
* Average evidence images reviewed per location
* Time saved per location
* Estimated total reviewer hours saved
* Percentage of locations processed without reviewing every image

---

# 5. Critical Safety / Quality Principle

## False approval is the highest-risk error.

A false approval may result in potential revenue loss for the client.

Therefore:

> **The system must optimize for trustworthy evidence, not maximum automation.**

The AI must be allowed to return:

* Supported
* Not supported
* Insufficient evidence
* Contradictory evidence
* Unable to determine

It must never be forced to make a binary decision when evidence is inadequate.

---

# 6. Product Philosophy

The platform follows five principles:

### 1. Evidence First

Every AI assessment should be connected to observable image evidence.

### 2. Location-Level Intelligence

Analyze all relevant images for a location collectively rather than treating every image as an isolated decision.

### 3. Human-in-the-Loop

Humans remain responsible for final decisions during the initial implementation.

### 4. Conservative Automation

High-risk or uncertain cases must be routed to human review.

### 5. Full Auditability

The system must record what the AI saw, what it concluded, why it concluded it, and what the human ultimately decided.

---

# 7. High-Level System Architecture

```text
                    ORACLE NETSUITE
                          |
                          v
                 +-------------------+
                 | Queue Orchestrator|
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 | Location Processor|
                 +---------+---------+
                           |
                           v
                 +-------------------+
                 | Image Acquisition |
                 +---------+---------+
                           |
                           v
              +---------------------------+
              |     AI VISION ENGINE      |
              |                           |
              | Service Detection         |
              | Image Quality             |
              | Scene Understanding       |
              | Before/After Analysis     |
              +-------------+-------------+
                            |
                            v
              +---------------------------+
              |   EVIDENCE ENGINE         |
              |                           |
              | Evidence Mapping          |
              | Evidence Aggregation      |
              | Evidence Ranking          |
              +-------------+-------------+
                            |
                            v
              +---------------------------+
              | RISK & CONTRADICTION      |
              | ENGINE                    |
              +-------------+-------------+
                            |
              +-------------+-------------+
              |                           |
              v                           v
      HIGH-CONFIDENCE               UNCERTAIN/RISKY
       ASSIST/FAST TRACK             HUMAN REVIEW
              |                           |
              +-------------+-------------+
                            |
                            v
                  FINAL HUMAN DECISION
                            |
                            v
                    NETSUITE UPDATE
                            |
                            v
                    AUDIT + ANALYTICS
```

---

# 8. Core Components

The system consists of the following major components:

1. Queue Orchestrator
2. Location Service Profile
3. Image Acquisition Layer
4. Image Quality Analyzer
5. Landscape Vision Engine
6. Before/After Intelligence Engine
7. Evidence Aggregation Engine
8. Evidence Bundler
9. Risk Engine
10. Contradiction Detector
11. Human Verification Workspace
12. NetSuite Integration Layer
13. Verification Knowledge Base
14. Feedback/Learning System
15. Queue Analytics Dashboard
16. Audit Log

---

# 9. Solution 1 — Multi-Service Evidence Engine

## Purpose

Determine whether the submitted images contain sufficient visual evidence for each required landscape service.

## Supported initial services

```text
LANDSCAPE_MAINTENANCE
LANDSCAPE_FERTILIZATION
EDGING
MOWING
WEED_REMOVAL
TREE_TRIMMING_PRUNING
TRASH_DEBRIS_LEAVES_REMOVAL
SHRUB_PRUNING
DEAD_BROWN_GRASS
```

The architecture must allow additional services to be added without rewriting the system.

---

# 10. Service Definition Model

Each service must have a configurable definition.

Example:

```json
{
  "service": "mowing",
  "display_name": "Mowing",
  "description": "Evidence that grass/lawn areas were mowed or maintained through mowing.",
  "requires_before_after": true,
  "minimum_confidence_for_assistance": 0.85,
  "requires_human_if_contradiction": true
}
```

Do NOT hard-code service rules throughout the application.

Service definitions must be configurable.

---

# 11. Client-Specific Verification Profiles

Different clients may have different requirements.

The system must support:

```text
Client
   |
   +-- Required Services
   +-- Evidence Rules
   +-- Before/After Requirements
   +-- Image Requirements
   +-- Exception Rules
   +-- Confidence Thresholds
```

Example:

```json
{
  "client": "CLIENT_A",
  "required_services": [
    "mowing",
    "edging",
    "shrub_pruning"
  ],
  "before_after_required": true,
  "equipment_alone_is_insufficient": true
}
```

Thresholds must be configurable rather than embedded in application logic.

---

# 12. Location-Level Processing

For every location, the system must create a processing object:

```text
Location
 ├── Client
 ├── Required Services
 ├── Images
 ├── Image Metadata
 ├── AI Findings
 ├── Evidence
 ├── Contradictions
 ├── Risk Score
 ├── AI Recommendation
 ├── Human Decision
 └── Audit History
```

The system must process the location as a single verification unit while retaining image-level evidence.

---

# 13. Image Acquisition

The system must obtain all available images associated with a location.

Potential source:

* NetSuite
* NetSuite-linked image storage
* External image URL
* Configurable future image provider

The integration layer must abstract the image source.

Do not build the vision engine directly around NetSuite-specific image retrieval logic.

Use an adapter pattern:

```text
ImageProvider
    |
    +-- NetSuiteImageProvider
    +-- ExternalImageProvider
    +-- MockImageProvider
```

This makes testing and future integration easier.

---

# 14. Image Quality Analyzer

Before attempting service verification, each image must be checked for quality.

Detect:

* Extremely blurry images
* Excessive darkness
* Excessive brightness
* Obstruction
* Very small usable area
* Duplicate images
* Near-duplicate images
* Irrelevant images
* Missing image
* Corrupted image
* Unsupported format

Each image receives:

```json
{
  "image_id": "IMG123",
  "quality_score": 0.91,
  "usable": true,
  "issues": []
}
```

If an image is unusable, the AI must not use it as positive evidence.

---

# 15. Duplicate and Near-Duplicate Detection

Locations may contain many images.

The platform must identify duplicate or near-duplicate images using image embeddings or perceptual hashing.

Example:

```text
170 submitted images
        ↓
31 duplicate/near-duplicate images
        ↓
139 unique/meaningfully different images
```

Duplicates should not artificially increase evidence confidence.

This is critical.

The AI must not conclude:

> "Strong evidence because 25 images show the same scene."

if those images are effectively duplicates.

---

# 16. Landscape Vision Engine

The vision engine analyzes images for relevant visual features.

The implementation must remain model-agnostic.

Possible vision model providers can be evaluated during implementation based on:

* accuracy
* cost
* latency
* API reliability
* image limits
* structured output support
* privacy/security requirements

Claude Code must NOT hard-code a specific AI provider unless explicitly configured.

Use an abstraction:

```text
VisionProvider
   |
   +-- ProviderA
   +-- ProviderB
   +-- LocalModel
```

---

# 17. AI Visual Analysis Output

Each image analysis should return structured data.

Example:

```json
{
  "image_id": "IMG_001",
  "observations": [
    {
      "service": "mowing",
      "evidence_strength": 0.92,
      "evidence_type": "maintained_lawn"
    },
    {
      "service": "edging",
      "evidence_strength": 0.81,
      "evidence_type": "defined_lawn_boundary"
    }
  ],
  "quality": {
    "score": 0.95,
    "usable": true
  }
}
```

The model must distinguish between:

### Observation

"What appears visible."

and:

### Verification conclusion

"Whether the service is sufficiently supported."

Do not allow the vision model to directly produce the final approval without the evidence/risk layer.

---

# 18. Before/After Intelligence Engine

Where before/after images are available, the system should identify likely pairs.

Pairing signals can include:

* visual similarity
* camera position
* scene structure
* location metadata
* timestamps, if available
* filenames
* image ordering
* visual landmarks

The system should never assume that adjacent images are automatically before/after pairs.

---

# 19. Before/After Analysis

For each candidate pair:

```text
BEFORE
   ↓
Scene understanding
   ↓
AFTER
   ↓
Scene understanding
   ↓
Change detection
   ↓
Service-specific interpretation
```

Example:

```text
Before:
Overgrown grass
Unclear lawn edge
Weeds visible

After:
Grass visibly shorter
Defined lawn boundary
Reduced visible weeds
```

The system generates structured evidence:

```json
{
  "service": "mowing",
  "before_evidence": "grass appears tall/overgrown",
  "after_evidence": "grass appears visibly shorter",
  "change_strength": 0.91
}
```

Important:

The system must distinguish:

> **Visual change detected**

from:

> **Service proven**

A visual change alone is not automatically proof that a specific service occurred.

---

# 20. Evidence Aggregation Engine

The Evidence Engine combines evidence from multiple images.

For each required service:

```text
Image Evidence
      +
Before/After Evidence
      +
Image Quality
      +
Evidence Diversity
      +
Contradictory Evidence
      +
Client Rules
      ↓
SERVICE EVIDENCE ASSESSMENT
```

Example:

```json
{
  "service": "mowing",
  "support_score": 0.94,
  "evidence_count": 4,
  "strongest_images": [
    "IMG12",
    "IMG18",
    "IMG21"
  ],
  "contradictions": [],
  "status": "SUPPORTED"
}
```

---

# 21. Evidence Diversity

Multiple images of the same scene should not count as independent strong evidence.

The system should consider:

* different angles
* different areas
* before/after pairs
* different timestamps
* distinct visual regions

Example:

```text
10 nearly identical images
```

should not be treated as:

```text
10 independent confirmations
```

This reduces false confidence.

---

# 22. Evidence Bundler

For each location, AI should select the smallest useful set of evidence images.

Example:

```text
87 submitted images
        ↓
AI evidence ranking
        ↓
14 strongest evidence images
```

Evidence should be grouped by service.

Example:

```text
MOWING
IMG12
IMG17
IMG31

EDGING
IMG17
IMG31

SHRUB PRUNING
IMG61
IMG63
```

One image can support multiple services.

---

# 23. Evidence Ranking

Each image should receive an evidence relevance score based on:

* visual clarity
* service relevance
* before/after relevance
* uniqueness
* geographic/scene coverage
* contradiction value
* image quality

The UI should show the strongest evidence first.

---

# 24. Risk Engine

The Risk Engine is a mandatory component.

It evaluates the likelihood that an AI-assisted decision could be wrong.

Risk factors include:

* Low confidence
* Poor image quality
* Missing before image
* Missing after image
* Contradictory images
* Insufficient service evidence
* Client-specific strict rules
* Unusual scene
* Duplicate-heavy evidence
* Multiple conflicting observations

Example:

```text
Risk = LOW
Risk = MEDIUM
Risk = HIGH
```

Do not expose a raw mathematical risk score to users unless it is properly calibrated.

Internally, a numerical score may be used.

---

# 25. Contradiction Detector

The system must actively search for evidence that challenges an apparent approval.

Example:

```text
Positive evidence:
IMG12 → lawn appears mowed

Contradictory evidence:
IMG18 → significant section still appears unmaintained
```

The system should flag:

> **Potential contradiction detected.**

This automatically routes the location to human review.

---

# 26. Evidence Sufficiency Rules

The system must distinguish:

### Supported

There is sufficient evidence to support the service.

### Not Supported

Available evidence does not support the service.

### Insufficient Evidence

The available images are inadequate to determine whether the service was performed.

### Contradictory

Different images provide conflicting evidence.

### Unable to Determine

The AI cannot reliably interpret the evidence.

These states must not be collapsed into a simple yes/no classification.

---

# 27. Human Review Rules

During Phase 1 and Phase 2:

> **No fully autonomous final approval.**

All AI results should be recommendations.

Human review must be triggered when:

* confidence is below configured threshold
* contradiction exists
* required before/after evidence is missing when required
* image quality is inadequate
* multiple services conflict
* client rule requires human review
* AI cannot determine the result
* system encounters an exception

---

# 28. Human Verification Workspace

The reviewer should see one location at a time.

The screen should contain:

```text
LOCATION
Client
Location ID
Required Services

----------------------------------

AI SERVICE ASSESSMENT

Mowing
SUPPORTED
Evidence: IMG12, IMG18
Confidence: High

Edging
SUPPORTED
Evidence: IMG18, IMG21
Confidence: High

Weed Removal
INSUFFICIENT
Evidence: IMG31
Review required

----------------------------------

CONTRADICTIONS

None

----------------------------------

EVIDENCE IMAGES

[Image] [Image] [Image]

----------------------------------

DECISION

[Approve]
[Reject]
[Needs More Review]
```

The UI must minimize clicks.

---

# 29. Human Reviewer Overrides

The reviewer must be able to override AI recommendations.

Example:

```text
AI:
Mowing = SUPPORTED

Human:
REJECT

Reason:
After image does not clearly show completed work.
```

The override must be stored.

---

# 30. Feedback Collection

When a reviewer overrides AI, the system should capture:

* AI recommendation
* Human decision
* Reason
* Relevant image
* Service
* Timestamp
* Reviewer ID

Optional reason categories:

```text
AI missed evidence
AI hallucinated evidence
Image insufficient
Before/after mismatch
Incorrect service interpretation
Client-specific rule
Contradictory evidence
Other
```

This creates valuable training/evaluation data.

---

# 31. Historical Notes Knowledge Base

Existing reviewer notes should be incorporated into a searchable knowledge base.

The knowledge base can contain:

* Previous verification notes
* Service definitions
* Client-specific instructions
* Known edge cases
* Weekly feedback
* Historical examples

The AI can retrieve relevant rules when evaluating a location.

However:

> Historical notes must not override current client configuration without explicit authorization.

---

# 32. AI Explainability

The AI must provide concise evidence-based explanations.

Good:

> "Mowing is supported because the before image shows visibly taller grass and the corresponding after image shows a substantially shorter, maintained lawn."

Bad:

> "This looks like professional mowing."

The system must avoid unsupported statements.

---

# 33. AI Confidence

Confidence must be treated as a model output that requires calibration.

Do not display:

> 97%

unless the underlying system has been evaluated and calibrated appropriately.

During the prototype phase, the UI can instead use:

* High
* Medium
* Low

Later, calibrated probabilities can be displayed.

---

# 34. Queue Orchestrator

The Queue Orchestrator manages the complete verification pipeline.

States:

```text
NEW
↓
QUEUED
↓
DOWNLOADING
↓
ANALYZING
↓
EVIDENCE_BUILDING
↓
AI_REVIEW_READY
↓
HUMAN_REVIEW
↓
APPROVED
or
REJECTED
or
ESCALATED
↓
SYNCED_TO_NETSUITE
↓
COMPLETED
```

Error states:

```text
IMAGE_ERROR
AI_ERROR
NETSUITE_ERROR
INTEGRATION_ERROR
```

Every state transition must be logged.

---

# 35. Intelligent Queue Prioritization

The system may prioritize locations based on:

* queue age
* number of images
* number of services
* AI confidence
* risk
* expected human review time
* client priority
* operational deadline

However, queue prioritization must remain configurable.

Default behavior should prioritize **oldest eligible work first**, unless a business rule explicitly changes priority.

---

# 36. Fast Lane / Review Lane / Exception Lane

The queue should have three conceptual lanes.

## Fast Lane

High-quality evidence and low risk.

## Human Review Lane

Evidence requires human confirmation.

## Exception Lane

System/integration/image problems require investigation.

Example:

```text
FAST LANE
342 locations

HUMAN REVIEW
119 locations

EXCEPTIONS
21 locations
```

---

# 37. NetSuite Integration

The NetSuite integration must be implemented as a separate service layer.

Required capabilities:

### Read

* Location queue
* Location ID
* Client
* Required services
* Image references
* Existing verification status

### Write

* Verification status
* Reviewer decision
* Notes
* Processing metadata where appropriate

### Important

Do not assume the exact NetSuite API, record type, field IDs, authentication mechanism, or image storage mechanism.

Claude Code must first inspect/provision the available integration details.

Create an integration configuration:

```env
NETSUITE_ACCOUNT_ID=
NETSUITE_CONSUMER_KEY=
NETSUITE_CONSUMER_SECRET=
NETSUITE_TOKEN_ID=
NETSUITE_TOKEN_SECRET=
NETSUITE_API_BASE_URL=
```

Actual credentials must never be committed to source control.

---

# 38. NetSuite Adapter

Use:

```text
NetSuiteAdapter
```

with methods conceptually similar to:

```text
getQueue()
getLocation(locationId)
getRequiredServices(locationId)
getImages(locationId)
updateVerification(locationId, result)
addVerificationNote(locationId, note)
```

The exact implementation must follow the actual NetSuite environment.

---

# 39. Integration Safety

NetSuite writes must be:

* authenticated
* validated
* logged
* retryable
* idempotent

If the AI system crashes after analysis but before NetSuite update, the location must not be duplicated or corrupted.

Use an internal processing ID.

---

# 40. Idempotency

Every processing job must have a unique ID.

Example:

```text
location_id
processing_run_id
image_id
analysis_version
timestamp
```

Reprocessing the same location must create a new analysis version without destroying the historical audit record.

---

# 41. Audit System

Every important event must be recorded.

Example:

```text
Location received
Images downloaded
AI analysis started
AI analysis completed
Evidence generated
Risk calculated
Human opened location
Human viewed evidence
Human changed AI recommendation
Final decision submitted
NetSuite updated
```

Audit records must be immutable from the normal user interface.

---

# 42. Processing Versioning

Every AI analysis must record:

```text
vision_model
vision_model_version
prompt_version
service_rules_version
client_profile_version
analysis_timestamp
application_version
```

This is essential for debugging and comparing model performance over time.

---

# 43. Reprocessing

The system must allow a location to be reprocessed.

Possible reasons:

* improved AI model
* changed client rule
* corrected service requirement
* additional images added
* reviewer dispute
* technical failure

The system must preserve the old result.

---

# 44. Dashboard

The Team Lead dashboard should display:

```text
TODAY

Locations received:       583
Processed:                562
Remaining:                 21

AI processed:             583
Human review:             119
Completed:                562

Average review time:      XX sec

AI agreement:             XX%
AI override rate:         XX%
False approval rate:      XX%
```

The dashboard should support filtering by:

* client
* service
* status
* date
* reviewer
* risk
* AI confidence
* exception type

---

# 45. Location Detail Page

Each location should show:

```text
Location
Client
Required Services
Image Count

AI Summary

Service-by-Service Evidence

Before/After Pairs

Contradictions

Evidence Images

All Images

AI Recommendation

Human Decision

Audit History
```

---

# 46. Search

Users should be able to search by:

* Location ID
* Client
* service
* status
* date
* verification result
* processing ID

---

# 47. Performance Requirements

The platform should be designed to handle:

* 500+ locations/day
* 1–170 images/location
* potentially tens of thousands of images/day

The architecture must support asynchronous processing.

Do NOT process all locations synchronously through a single web request.

Use:

```text
Queue
↓
Workers
↓
AI processing
↓
Results database
```

---

# 48. Batch Processing

Images must be analyzed in batches where the selected AI provider supports it.

However:

> Do not sacrifice evidence quality simply to reduce API calls.

The implementation should balance:

* latency
* cost
* accuracy
* API limits
* image count

---

# 49. Cost Control

AI image analysis can become expensive at high image volumes.

The system should implement:

### Deduplication

Avoid analyzing duplicate images repeatedly.

### Caching

Cache analysis results using a content hash.

### Evidence-first processing

Use inexpensive preprocessing before expensive vision analysis where possible.

### Progressive analysis

Do not necessarily perform the most expensive analysis on every image.

Possible pipeline:

```text
Image
↓
Quality check
↓
Duplicate detection
↓
Basic relevance analysis
↓
Service analysis
↓
Deep before/after analysis if needed
```

---

# 50. Security

The application must:

* protect NetSuite credentials
* encrypt sensitive data in transit
* encrypt sensitive data at rest where appropriate
* implement authentication
* implement authorization
* log administrative activity
* prevent unauthorized access to client images
* avoid exposing images through public URLs
* use secure temporary URLs where necessary

---

# 51. Privacy

Images should be retained only according to the organization's approved retention policy.

The implementation must make retention configurable.

Do not permanently retain images simply because they were processed by the AI.

---

# 52. User Roles

Initial roles:

## Reviewer

Can:

* view assigned locations
* inspect AI evidence
* approve
* reject
* override AI
* add notes

## Team Lead

Can additionally:

* view dashboard
* review exceptions
* manage queues
* inspect AI performance
* manage service rules

## Administrator

Can additionally:

* configure integrations
* manage users
* configure AI providers
* manage system settings

---

# 53. AI Automation Levels

The system must support progressive automation.

## Level 0 — Manual

No AI decision assistance.

## Level 1 — AI Analysis

AI analyzes images and presents findings.

Human makes every decision.

## Level 2 — AI Evidence Bundling

AI selects relevant evidence and highlights exceptions.

Human makes every decision.

## Level 3 — AI-Assisted Fast Track

Very high-confidence cases can be placed in a fast-track queue.

Human confirmation remains required.

## Level 4 — Controlled Auto-Processing

Only after sufficient historical validation may specific low-risk cases be automatically processed.

## Level 5 — Expanded Automation

Additional service/client combinations may be automated only after meeting independently defined accuracy thresholds.

**Do not implement Level 4 or Level 5 in the initial production release.**

---

# 54. Automation Gate

Before any automated final approval is enabled for a service/client combination, the system must demonstrate acceptable performance on a representative validation dataset.

At minimum measure:

* precision
* recall
* false approval rate
* false rejection rate
* human override rate
* performance by service
* performance by client
* performance by image quality
* performance by scene type

The business must explicitly approve the threshold.

Do not hard-code arbitrary claims such as "95% accuracy is enough."

---

# 55. Golden Dataset

Before production automation, create a labeled dataset of real historical examples.

Each example should contain:

```text
Location
Client
Required Service
Images
Expected Result
Reviewer Decision
Reason
```

The dataset should include difficult cases, not only easy examples.

It must include:

* clear approvals
* clear rejections
* ambiguous cases
* poor-quality images
* contradictory images
* different landscaping conditions
* different clients
* multiple services

---

# 56. Evaluation Framework

Every model/prompt version should be evaluated against the golden dataset.

Generate a report:

```text
Model Version
Service
Samples
Correct
Incorrect
False Approval
False Rejection
Human Override
```

This allows the team to objectively determine whether a new model is actually better.

---

# 57. No Self-Training Without Validation

The system may collect human corrections for future improvement.

However:

> Human feedback must not automatically change production behavior.

New rules/models/prompts must go through:

```text
Feedback
↓
Dataset
↓
Evaluation
↓
Review
↓
Approval
↓
Production deployment
```

---

# 58. AI Prompt Architecture

Do not embed giant prompts throughout the application.

Use versioned prompt templates.

Example:

```text
/prompts/
    image_analysis_v1.txt
    before_after_v1.txt
    evidence_aggregation_v1.txt
    contradiction_v1.txt
```

Prompts must be versioned.

---

# 59. Structured AI Outputs

AI responses must use strict structured schemas wherever supported.

Avoid parsing unreliable free-form text.

Example:

```json
{
  "service": "mowing",
  "status": "SUPPORTED",
  "confidence_level": "HIGH",
  "supporting_images": ["IMG12", "IMG18"],
  "contradicting_images": [],
  "evidence": [
    {
      "image_id": "IMG12",
      "observation": "Grass appears significantly taller in before image"
    }
  ]
}
```

---

# 60. AI Hallucination Prevention

The system must instruct vision models:

* Never claim evidence that is not visible.
* Never infer hidden work.
* Do not treat equipment as proof of completed service.
* Do not treat green grass as proof of fertilization.
* Do not treat an aesthetically pleasing landscape as proof that all required services occurred.
* Do not infer before/after relationships without sufficient evidence.
* Return insufficient evidence when appropriate.

---

# 61. Special Caution: Fertilization

Fertilization is particularly difficult to verify visually.

A photograph may show healthy grass, but healthy grass alone does not prove fertilization.

Therefore:

> **Fertilization should initially default to human review unless the business provides additional verifiable evidence or metadata.**

The system must not claim that fertilizer was applied solely because the lawn looks healthy.

---

# 62. Special Caution: Weed Removal

Weed removal can also be difficult to verify from images alone.

The AI should distinguish:

```text
Weeds visible
Weeds reduced
Area appears maintained
Service visually supported
```

These are not automatically equivalent.

---

# 63. Special Caution: Landscape Maintenance

"Landscape maintenance" is broad.

The system should not use one generic visual rule.

It should decompose the assessment into observable evidence such as:

* maintained appearance
* lawn condition
* visible debris
* edging
* pruning
* weed presence
* plant-bed condition

The client-specific definition should determine what constitutes sufficient evidence.

---

# 64. Special Caution: Dead/Brown Grass

The system should identify visible dead/brown grass but must distinguish:

> **Dead/brown grass observed**

from:

> **Dead/brown grass service successfully addressed.**

These are different business questions.

---

# 65. Initial Implementation Scope

## Phase 1 — Foundation

Implement:

* Application architecture
* Database
* Authentication
* NetSuite integration abstraction
* Queue ingestion
* Image ingestion
* Job processing
* Audit logging
* Basic dashboard

No automated decisions.

---

# 66. Phase 2 — Vision Prototype

Implement:

* Image quality analysis
* Duplicate detection
* Landscape service detection
* Structured AI output
* Image-level evidence

Test against real examples.

---

# 67. Phase 3 — Location Evidence Engine

Implement:

* Multi-image aggregation
* Service-level evidence
* Evidence ranking
* Evidence bundling
* Before/after candidate pairing
* Before/after comparison

---

# 68. Phase 4 — Risk & Human Review

Implement:

* Risk engine
* Contradiction detection
* Human review workspace
* AI recommendation
* Human override
* Feedback capture

---

# 69. Phase 5 — Queue Intelligence

Implement:

* Fast lane
* Human review lane
* Exception lane
* Intelligent prioritization
* Team dashboard
* Time-saving analytics

---

# 70. Phase 6 — Validation

Create the golden dataset.

Measure:

* service-level precision
* service-level recall
* false approvals
* false rejections
* reviewer agreement
* time savings
* AI confidence calibration

Do not proceed to automated final decisions without passing agreed business thresholds.

---

# 71. Phase 7 — Controlled Automation

Only after validation:

* Enable fast-track processing
* Enable automation for explicitly approved service/client combinations
* Monitor every automated decision
* Maintain rollback capability
* Continuously sample automated decisions for human quality control

---

# 72. Database Model

Minimum entities:

```text
users
clients
client_profiles
locations
services
location_services
images
image_analysis
image_pairs
evidence
service_assessments
risk_assessments
contradictions
verification_jobs
human_reviews
audit_events
feedback
prompt_versions
model_versions
processing_runs
system_errors
```

---

# 73. Example Location Record

```json
{
  "location_id": "10482",
  "client_id": "CLIENT_A",
  "required_services": [
    "mowing",
    "edging",
    "weed_removal",
    "shrub_pruning"
  ],
  "image_count": 87,
  "processing_status": "AI_REVIEW_READY"
}
```

---

# 74. Example Service Assessment

```json
{
  "location_id": "10482",
  "service": "mowing",
  "status": "SUPPORTED",
  "confidence_level": "HIGH",
  "supporting_images": [
    "IMG12",
    "IMG18"
  ],
  "contradicting_images": [],
  "human_required": false
}
```

---

# 75. Example High-Risk Case

```json
{
  "location_id": "10483",
  "service": "weed_removal",
  "status": "INSUFFICIENT_EVIDENCE",
  "confidence_level": "LOW",
  "supporting_images": [
    "IMG44"
  ],
  "contradicting_images": [
    "IMG51"
  ],
  "human_required": true
}
```

---

# 76. API Design

Suggested internal API:

```text
POST   /api/jobs/location/:id
GET    /api/jobs/:id
GET    /api/locations
GET    /api/locations/:id
GET    /api/locations/:id/evidence
GET    /api/locations/:id/images
POST   /api/locations/:id/review
POST   /api/locations/:id/reprocess
GET    /api/dashboard
GET    /api/analytics
GET    /api/services
GET    /api/clients
```

The exact framework may be selected based on the existing project environment.

---

# 77. Error Handling

Every external dependency must handle:

* timeout
* rate limit
* authentication failure
* invalid response
* malformed image
* unavailable image
* AI provider outage
* NetSuite outage
* database failure

Errors must be:

* logged
* retryable where appropriate
* visible in the exception queue

---

# 78. Retry Strategy

Use exponential backoff for transient failures.

Do not endlessly retry permanent failures.

Example categories:

```text
TRANSIENT
→ retry

AUTHENTICATION
→ stop and alert

INVALID IMAGE
→ exception

MODEL ERROR
→ retry

NETSUITE VALIDATION ERROR
→ human/admin intervention
```

---

# 79. Observability

Implement:

* application logs
* processing metrics
* AI latency
* AI cost tracking
* NetSuite API latency
* error rates
* queue processing rate
* worker health

The team should be able to determine:

> "Why is today's queue not clearing?"

without inspecting application code.

---

# 80. Cost Monitoring

Track AI usage per:

* image
* location
* client
* service
* processing run

Example:

```text
Location #10482
87 images
Vision analysis cost
Before/after analysis cost
Total AI cost
```

This allows the business to calculate:

> AI cost per verified location

and compare it with:

> Human verification cost per location.

---

# 81. Technology Architecture

Claude Code may choose the exact implementation stack, but the architecture should generally contain:

```text
Frontend
    ↓
Backend API
    ↓
Job Queue
    ↓
Workers
    ↓
AI Services
    ↓
Database
    ↓
NetSuite Integration
```

Recommended characteristics:

* Type-safe backend where practical
* Relational database for transactional data
* Object storage for temporary image processing if required
* Queue-based asynchronous processing
* REST API
* Environment-based configuration
* Automated tests
* Docker support where appropriate

Do not introduce unnecessary infrastructure.

Prefer the simplest architecture that can reliably handle the expected workload.

---

# 82. Local Development

Claude Code must provide:

```text
.env.example
README.md
docker-compose.yml
database migrations
seed data
mock NetSuite adapter
mock AI provider
test fixtures
```

The application must run locally without requiring production NetSuite credentials.

---

# 83. Mock Mode

Create a complete mock mode.

Example:

```text
MOCK_NETSUITE=true
MOCK_AI=true
```

Mock mode should generate:

* sample locations
* sample service requirements
* sample image metadata
* simulated AI results
* human review scenarios

This allows development without production access.

---

# 84. Testing Strategy

Implement:

## Unit Tests

For:

* service rules
* evidence aggregation
* risk calculation
* contradiction detection
* queue states
* scoring
* client profiles

## Integration Tests

For:

* NetSuite adapter
* image provider
* AI provider
* database
* job queue

## End-to-End Tests

Test:

```text
Location
→ Images
→ AI
→ Evidence
→ Risk
→ Human review
→ NetSuite update
```

---

# 85. AI Evaluation Tests

AI tests must include actual image examples once provided.

Create test cases:

```text
clear positive
clear negative
ambiguous
poor quality
duplicate
contradiction
before/after
multiple services
missing before
missing after
```

---

# 86. User Experience Requirements

The reviewer should not have to:

* open every image manually
* repeatedly navigate between pages
* search for relevant evidence
* remember which services are required
* manually compare obvious before/after images

The interface should make the reviewer ask:

> **"Do I agree with the evidence?"**

rather than:

> **"What am I supposed to look for?"**

---

# 87. Performance Target

Initial target:

> Reduce the number of images requiring manual inspection substantially while maintaining a conservative quality profile.

Do not set an arbitrary percentage before testing real images.

After the pilot, establish measurable targets based on:

* baseline human time
* actual AI performance
* false approval rate
* reviewer override rate

---

# 88. Pilot Strategy

Do not deploy immediately to the entire 500+ location queue.

Start with a controlled historical dataset.

Recommended pilot:

```text
Historical locations
       ↓
Human-labeled ground truth
       ↓
AI processing
       ↓
Compare AI vs human
       ↓
Error analysis
       ↓
Model/prompt/rule improvements
       ↓
Shadow production
       ↓
Human verification
       ↓
Controlled rollout
```

---

# 89. Shadow Mode

Before allowing AI recommendations to influence production decisions, run the AI in shadow mode.

The human reviewer continues the normal process.

The system silently records:

```text
AI result
Human result
Agreement
Disagreement
Processing time
```

This provides real-world validation without exposing the business to AI-driven approval risk.

---

# 90. Rollout Strategy

### Stage 1

AI analyzes historical data.

### Stage 2

AI analyzes live data but does not affect decisions.

### Stage 3

AI assists human reviewers.

### Stage 4

AI evidence bundling becomes standard workflow.

### Stage 5

Controlled fast-track processing.

### Stage 6

Potential automation of selected low-risk cases.

---

# 91. Definition of Done — MVP

The MVP is complete when:

* NetSuite queue can be imported.
* Locations can be processed.
* Images can be retrieved.
* Images can be analyzed.
* Required services can be identified.
* AI produces structured evidence.
* Duplicate images are detected.
* Before/after candidates can be identified.
* Evidence can be grouped by service.
* Risk/contradiction flags work.
* Human reviewer can inspect evidence.
* Human can approve/reject/override.
* Results are persisted.
* Audit history exists.
* Queue dashboard exists.
* Errors are visible.
* Mock mode works.
* Automated tests exist.
* No production credentials are stored in source control.

---

# 92. Definition of Done — Production Readiness

Before production rollout:

* NetSuite integration validated.
* Authentication secured.
* Image access secured.
* AI provider reliability tested.
* Golden dataset created.
* AI evaluation completed.
* False approval rate measured.
* False rejection rate measured.
* Human override rate measured.
* Cost per location measured.
* Performance under expected volume tested.
* Retry mechanisms tested.
* Audit logging validated.
* Backup/recovery strategy documented.
* Human review workflow approved by business owner.

---

# 93. Non-Goals for Version 1

Do NOT attempt to:

* fully replace human reviewers
* automatically approve all locations
* infer services that cannot be visually verified
* claim fertilization solely from lawn appearance
* train a custom computer-vision model before enough labeled data exists
* build unnecessary complex infrastructure
* automatically learn production rules from reviewer feedback
* modify NetSuite records without explicit integration requirements
* optimize for AI accuracy at the expense of false approvals

---

# 94. Future Opportunities

After the core system is proven, consider:

### Computer Vision Fine-Tuning

Build specialized models using accumulated labeled images.

### Active Learning

Automatically identify the images most valuable for human labeling.

### Predictive Workload Forecasting

Estimate tomorrow's queue volume and reviewer workload.

### Automated Quality Sampling

Randomly send AI-approved cases to humans for quality control.

### Client Analytics

Identify recurring service-quality issues by client/location.

### Geographic Intelligence

Analyze service patterns by region.

### Mobile Review

Allow reviewers to verify locations from mobile devices.

### Continuous Benchmarking

Compare AI versions against the same golden dataset.

---

# 95. Most Important Architectural Decision

The system should not be:

```text
IMAGE
↓
AI
↓
APPROVE / REJECT
```

It must be:

```text
LOCATION
↓
REQUIRED SERVICES
↓
ALL AVAILABLE IMAGES
↓
IMAGE QUALITY
↓
VISUAL OBSERVATIONS
↓
BEFORE/AFTER ANALYSIS
↓
SERVICE-SPECIFIC EVIDENCE
↓
EVIDENCE AGGREGATION
↓
CONTRADICTION CHECK
↓
RISK ASSESSMENT
↓
AI RECOMMENDATION
↓
HUMAN DECISION
↓
AUDIT
↓
NETSUITE
```

This is the core architecture of the product.

---

# 96. Claude Code Implementation Instructions

Claude Code must follow this PRD as the primary product specification.

## Mandatory implementation behavior

1. **Read this PRD completely before writing production code.**

2. Do not immediately start coding if critical external integration information is missing.

3. First inspect the repository and determine:

   * existing architecture
   * programming language
   * framework
   * database
   * existing integrations
   * deployment environment

4. Identify assumptions explicitly.

5. Separate:

   * confirmed requirements
   * implementation assumptions
   * unknown integration requirements

6. Do not invent NetSuite APIs, record types, fields, credentials, or image URLs.

7. Build interfaces/adapters around external dependencies.

8. Implement mock providers so development can proceed without production credentials.

9. Keep AI provider logic modular.

10. Use structured AI outputs.

11. Version prompts and model configurations.

12. Implement audit logging from the beginning.

13. Implement human review before attempting automation.

14. Never implement automatic final approval merely because the AI returns high confidence.

15. Keep all confidence thresholds configurable.

16. Never hard-code client-specific rules.

17. Write tests before considering each major module complete.

18. Do not delete existing functionality without understanding its purpose.

19. Before modifying an existing project, inspect it thoroughly.

20. After implementation, run tests and perform a complete end-to-end validation.

---

# 97. Claude Code Development Sequence

Claude Code should implement in this order:

```text
PHASE 0
Repository & environment inspection

↓

PHASE 1
Architecture + database + configuration

↓

PHASE 2
Queue + location processing

↓

PHASE 3
Image ingestion + quality + deduplication

↓

PHASE 4
AI vision abstraction

↓

PHASE 5
Service evidence engine

↓

PHASE 6
Before/after intelligence

↓

PHASE 7
Evidence bundling

↓

PHASE 8
Risk + contradiction engine

↓

PHASE 9
Human review UI

↓

PHASE 10
Audit + feedback

↓

PHASE 11
NetSuite synchronization

↓

PHASE 12
Dashboard + analytics

↓

PHASE 13
Golden dataset + AI evaluation

↓

PHASE 14
Pilot/shadow mode

↓

PHASE 15
Controlled production rollout
```

---

# 98. Required Documentation

Claude Code must create and maintain:

```text
README.md
ARCHITECTURE.md
API.md
DATABASE.md
NETSUITE_INTEGRATION.md
AI_PIPELINE.md
AI_EVALUATION.md
SECURITY.md
DEPLOYMENT.md
TROUBLESHOOTING.md
CHANGELOG.md
```

The documentation must remain synchronized with implementation.

---

# 99. Final Product Vision

The final system should make the reviewer's job fundamentally different.

### Current workflow

```text
500+ locations
       ↓
Open location
       ↓
Open image
       ↓
Inspect
       ↓
Decide
       ↓
Record
       ↓
Next image
       ↓
Next location
```

### Target workflow

```text
500+ locations
       ↓
AI processes queue
       ↓
AI understands required services
       ↓
AI analyzes all images
       ↓
AI compares before/after evidence
       ↓
AI identifies strongest evidence
       ↓
AI detects contradictions
       ↓
AI separates low-risk from uncertain cases
       ↓
Reviewer handles exceptions
       ↓
Final result synchronized to NetSuite
       ↓
Dashboard confirms queue clearance
```

The goal is not simply to make AI "look at pictures."

The goal is to transform the operation from **manual image inspection** into an **evidence-driven verification system**.

---

# 100. Final Instruction to Claude Code

> **Implement this PRD as a production-oriented AI-assisted landscape verification platform.**
>
> Challenge assumptions before implementation. Do not blindly follow an architectural decision if repository inspection or technical constraints demonstrate that a different implementation is safer or more maintainable.
>
> Preserve the business intent of this PRD:
>
> **Reduce manual verification workload while protecting against false approvals.**
>
> Build the system incrementally.
>
> Do not jump directly to autonomous approval.
>
> Establish measurable ground truth first.
>
> Make AI decisions explainable, auditable, reversible, and testable.
>
> Treat "insufficient evidence" as a valid result.
>
> Treat contradictory evidence as a reason for human review.
>
> Never invent visual evidence.
>
> Never infer that a service occurred when the available images cannot support that conclusion.
>
> Keep NetSuite, AI providers, image storage, and other external services behind clean interfaces.
>
> Use mock implementations during development.
>
> Maintain automated tests throughout implementation.
>
> Before declaring the project complete, demonstrate the full workflow:
>
> **NetSuite queue → location → images → AI analysis → evidence → risk → human review → final decision → NetSuite synchronization → audit trail → dashboard.**
>
> The system must be designed so that automation can increase over time as objective evidence demonstrates that it is safe to do so.
