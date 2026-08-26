# Scheduled agents and bots: a starting setup

I run 24 scheduled agents and 6 bots on one box. This folder is the shape of
that setup with my own data taken out, so you can copy the structure instead of
starting from an empty screen.

Nothing here is code you need to build. Auto agents and bots are config that
omg already reads. The hard part is not wiring them up, it is writing them so
they stay quiet.

## The one rule that makes scheduled agents usable

A scheduled agent that reports every run is a scheduled agent you stop reading
after four days. Mine are told, in the prompt itself: report only when something
is actually wrong, and report exactly one thing.

That single line is most of the value. Every prompt I keep has some version of it:

> Report only if something is really there, and then exactly one thing. If
> nothing changed, return nothing.

Findings land in `data/auto/findings.jsonl`. An empty file after a night of runs
is the correct outcome, not a broken cron.

## Anatomy of an auto agent

See `auto-agents.example.json`. The fields that matter:

- `schedule` is standard cron, in the host's timezone.
- `cwd` and `projectCwd` decide what the agent can see. Point them at the
  narrowest folder that still holds the answer.
- `agent` and `model` pick the runtime. Cheap model for watchers that mostly
  return nothing, stronger model for the ones that write.
- `thinkingLevel` is worth turning down on mechanical checks. Most watchers do
  not need to think, they need to compare two files.
- `tools` is a whitelist. A watcher gets read tools only. If it cannot write, a
  bad prompt costs you nothing.
- `enabled` lets you park an agent without deleting the prompt you spent an hour
  writing.

## Spread the cron times

Mine sit at 01:45, 06:00, 07:30, 08:00, 08:15, 08:45, 09:00, 09:15, 10:00,
11:00, 14:00, 21:30, 23:30. Not one of them is on the hour by accident. Agents
that fire together fight over the same CPU and the same rate limits, and when
one hangs you cannot tell which.

Weekly work goes on Friday morning, so I read it while the week is still fresh.
One-off measurements get a date-specific cron (`0 9 24 8 *`) instead of a note
somewhere that I will never open again. That trick is worth more than it looks:
if an experiment has a measurement date, the schedule is the reminder.

## Tell the agent what to read

The prompts that work name the files. Not "check the pipeline" but "read
queue-YYYY-MM-DD.json, seen.jsonl and backlog.md, and here is what each column
means". An agent that has to go find the state first will guess, and a guessing
watcher reports noise.

Same for the failure mode. I write out what a real problem looks like, numbered,
so the agent matches against a list instead of forming an opinion.

## Bots

See `bots.example.json`. A bot is a long-lived conversation with a persona and a
working folder, not a scheduled run. I use one per role: a copy reviewer, an SEO
strategist, a release watcher, a conversion controller.

The split that works for me: if I want to ask, it is a bot. If I want to be
told, it is an auto agent.

Keep the persona short and specific about what the bot refuses to do. A persona
that only lists what it is good at will happily answer things it should have
pushed back on.

## Getting started

1. Copy the two example files into your own `data/auto/` and `data/bots/`.
2. Replace every path. The examples use `/home/you/project` on purpose so a
   half-edited config fails loudly instead of running somewhere real.
3. Start with two agents, not twenty. One that watches something you already
   check by hand, one that runs weekly.
4. After a week, delete the ones that never found anything true. I have thrown
   away more scheduled agents than I have kept.

## What is not in here

My own prompts. They are full of my domains, servers and clients, and they would
be useless to you anyway. The structure is the transferable part.
