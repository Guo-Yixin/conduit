# Why Conduit?

Conduit is for a narrower problem than most workflow and agent frameworks:
repeatedly producing AI-generated artifacts while making quality, rework, cost,
and human judgment explicit parts of execution.

That distinction matters. Temporal, n8n, and LangGraph are all good choices in
their lanes. Conduit is compelling when the hard question is not merely “did the
workflow run?” but “was the result inspected, was rework bounded, and can we
explain why this artifact was accepted?”

Last reviewed against the linked official documentation: 2026-08-27.

## The short answer

Use Conduit when all of these are true:

- AI produces or evaluates an artifact.
- A first draft is not trustworthy enough to ship automatically.
- Maker and checker should be separate roles.
- Rejection should cause specific, bounded rework rather than a generic retry.
- Cost, attempts, findings, human decisions, and terminal outcomes need one
  durable audit trail.
- The legal route through the workflow should remain deterministic even when the
  labor is not.

If those are not the central requirements, another tool is probably a better
starting point.

## The different center of gravity

| Tool | Primary abstraction | Reach for it when |
|---|---|---|
| **Conduit** | An artifact moving through stations, inspection gates, bounded rework, and explicit terminal outcomes | The product is AI-generated work and the main risk is variable quality, silent rejection loops, or unaccounted cost |
| **Temporal** | Durable application workflows and activities | The main risk is infrastructure failure across long-running, mission-critical business processes |
| **n8n** | A visual integration workflow made of app and data-processing nodes | The main job is connecting APIs and SaaS systems quickly with little code |
| **LangGraph** | A stateful graph for agents and long-running, tool-using model applications | The main job is controlling an agent's state, tool loop, streaming, memory, or dynamic interaction |

This is a difference in defaults, not a claim that the other systems are
incapable. You can implement maker/checker separation, budgets, or bounded
quality loops using general orchestration primitives. Conduit's value is that
those policies are the runtime's native vocabulary and journal model rather
than application conventions every team must design and enforce again.

## Why not Temporal?

[Temporal](https://docs.temporal.io/) is designed for crash-proof durable
execution: application workflows resume after process, network, or
infrastructure failures, including workflows that last for very long periods.
That is a broader and more mature durability problem than Conduit attempts to
solve.

Choose Temporal first when you need:

- multi-service business transactions, schedules, signals, and long-lived
  process coordination;
- mature distributed execution and operational infrastructure;
- durable timers and recovery across services or hosts;
- a general application platform where AI is only one activity among many.

Choose Conduit first when one durable business process contains a production
line of non-deterministic AI work and the missing abstraction is quality
control. Conduit distinguishes an execution failure from a quality rejection,
routes critic findings back to the correct maker, caps rework, records model and
artifact bindings for resume, and gives `pass`, `scrap`, and `hold` explicit
meanings.

They can be complementary: Temporal can own the outer business process while a
Conduit run performs one quality-controlled AI production stage. Temporal is the
stronger answer to “will this business process survive?” Conduit is the more
opinionated answer to “why was this AI artifact allowed to advance?”

## Why not n8n?

[n8n](https://docs.n8n.io/) describes itself as a workflow automation tool that
combines AI capabilities with business-process automation. Its strength is
connecting applications and APIs through a visual workflow, built-in nodes,
credentials, triggers, and low-code data mapping.

Choose n8n first when you need:

- a large catalog of SaaS and API integrations;
- a visual canvas that non-specialists can edit;
- webhook-to-CRM, spreadsheet, email, ticketing, or data-sync automation;
- fast operational glue where each node's successful completion is the main
  execution concern.

Choose Conduit first when a successful API call is not evidence that the work is
good. Conduit's graph is intentionally a production line: stations declare
inputs and outputs, gates produce verdicts and findings, rejected work follows a
bounded back-edge, and the journal preserves the full quality history. That is a
more constrained authoring model, but the constraint is the feature when AI
quality is the product risk.

They can also sit together: n8n can collect a trigger or deliver an accepted
artifact, while Conduit owns the expensive maker/checker/rework section in the
middle.

## Why not LangGraph?

[LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) is a
low-level orchestration runtime for long-running, stateful agents. Its official
documentation emphasizes durable execution, persistence, streaming, and
human-in-the-loop. Its
[persistence model](https://docs.langchain.com/oss/python/langgraph/persistence)
checkpoints graph state, and
[interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) pause a
graph for external input and later resume it.

Choose LangGraph first when you need:

- an agent whose next action depends dynamically on accumulated state;
- first-class tool-calling loops, conversational memory, streaming, or state
  inspection;
- fine-grained control over agent nodes and transitions in application code;
- a general substrate for many agent architectures rather than one opinionated
  quality process.

Choose Conduit first when you do not want the model or agent loop to own the
production route. In Conduit, an LLM can make an artifact or judge one, but the
kernel decides the legal next state. Maker and checker are separate stations;
rework has explicit caps; consumption and liveness are separate stop
conditions; effectful work uses intent and idempotency discipline; and a run
ends in a named operational outcome.

A LangGraph application could still be packaged behind a Conduit harness or
deterministic adapter when one station genuinely needs a dynamic agent. In that
shape, LangGraph owns the local reasoning loop and Conduit owns the surrounding
artifact contract, quality gate, budget, and route.

## What Conduit gives up

Conduit's opinionated model has real costs:

- It is a developer preview with a much smaller ecosystem and user community.
- It is single-host and SQLite-based today; it is not a distributed durability
  platform.
- It has no visual workflow canvas or broad connector marketplace.
- Its Law-grade in-kernel agentic Tool-Bridge remains planned. The shipped
  `kind: harness` tier has a deliberately narrower containment claim.
- Fixed, inspectable production lines are a better fit than highly dynamic
  conversational agents.

Those limitations are reasons to choose another tool, not footnotes to hide.

## The practical decision

Start with the system whose native abstraction matches your hardest failure:

- **Business process disappears or must coordinate reliably across services:**
  Temporal.
- **Applications need to be connected quickly:** n8n.
- **An agent needs dynamic state, tools, memory, and interrupts:** LangGraph.
- **AI work completes but is variably good, expensive to redo, and difficult to
  audit:** Conduit.

Conduit's bet is that AI production needs more than orchestration. It needs a
quality system: separate makers and inspectors, explicit findings, bounded
rework, proof-carrying checkpoints, and a deterministic authority that knows
when to accept, reject, or escalate.
