# Configuration and Experiments

How the product is tuned at runtime, and how an experiment enrols accounts,
varies what they get, and reads its own result. A fork runs the same work with
its own numbers, and none of it needs a deploy to change.

**The one rule:** configuration is code with a runtime override. Every tunable
is declared once in the settings registry with a default and a schema; a super
user edits the override on su.donkeycut.com; env holds secrets and nothing
else. An experiment is a set of variants over settings, drawn by an audience.

## Settings

The registry is one file that lists every setting the product has. Each entry
carries a schema, a default, a title and description for the su form, and
whether the value is public. A public setting reaches the browser through the
account config route; a server setting is read only by handlers, webhooks and
jobs.

A value resolves in three layers, later ones winning:

```text
default (code)
    │
    ▼
override (SettingOverride row, edited on su)
    │
    ▼
variant (the experiment the account is assigned to)
```

The registry parses every default against its schema when the module loads,
so a wrong default fails the process at boot. A stored override that no longer
parses after a schema change is skipped, logged, and shown on su as invalid so
it can be reset. The su settings tab draws its form from the schema, so a new
setting needs no form code.

**Every tunable is a setting.** A threshold, a switch, a mode: if an operator
might want it different, it is a registry entry, and a feature that people
might tune ships its setting in the same change. A bare constant is right only
when one value fits every install.

## Experiments

An experiment has an audience, variants, and metrics. The variants each carry
a full value for every setting they change; the first variant is the control
the others are measured against. A variant may change nothing, in which case
the app reads the variant key itself. Its status walks draft to running,
running to paused and back, and either to ended.

### Audience

The audience is a set of rules over facts about the account, all optional; an
empty audience admits everyone. The rules cover where the assigning request
came from, when the account was created, whether it holds Pro, whether it has
ever paid, how recently it was active, and how much of its storage quota and
its credits it has used. Rules combine; every rule set must hold.

Facts are collected only when a running experiment the account does not yet
hold asks for them, and only the facts its rules read, so an experiment over
countries costs no billing query and an account that already holds every
running experiment costs none. A new rule is a field in the audience schema,
a fact, a line in the matcher, and the query that collects the fact.

### Assignment

Assignment is deterministic. The account id is hashed with the experiment key
under two salts: one decides whether the account is in the enrolled share,
the other picks the variant by weight. Raising the share only adds accounts,
and an account's variant never moves. The first read writes the assignment
row, and from then on the row is what the account reads, whatever the
audience says later. A paused experiment keeps its rows and applies nothing;
resuming picks up where it left off.

```text
app loads signed in
    │
    ▼
GET /api/account/config
    │  assigns any running experiment the account is eligible for
    │  marks first exposures
    ▼
browser registers $feature/<key> = variant on every later event
    │  first exposure → experiment_exposed
    ▼
the app reads public settings and variant keys from the response
```

A variant reaches the product through the account's own config read, so an
experiment varies a public setting. A setting only the server reads resolves
without a user and is changed with an override.

Country comes from the platform's request header at assignment time and is
stored on the assignment row, so a report can say where each cohort was.

### Overrides by account

An account can be placed by hand. On su, an experiment takes an email and a
variant, and that row stands in place of the hash from then on; the same form
holds the account out of that one experiment. A holdout list, kept beside the
experiments, keeps an account out of every experiment: it is never assigned,
reads the plain configuration even where it holds a row, and never counts in a
result. Rows written by hand are never counted either.

### Results

A metric is something an exposed account does after its exposure: a PostHog
event by name, or a purchase recorded in the credit grants. An experiment
lists its metrics, and the first one decides the verdict.

A nightly job computes each live experiment's read and stores it on the row;
su shows it, with a button to compute one experiment now. For every metric
and variant it counts exposed accounts and how many converted, then compares
each variant to the control two ways: a classical two-proportion test for the
p-value, and a Beta-Binomial posterior for the chance the variant beats the
control. The verdict is one of four:

| Verdict | Means |
|---|---|
| Too early | an arm is under the minimum exposures, or too few conversions have landed |
| Keep running | enough data, no clear difference; shown with the exposures each arm needs to read a planned lift |
| Ship it | a variant beats the control with p under 0.05 on a full sample |
| Stop it | every variant is very unlikely to beat the control, called on a small sample so a loser is stopped early |

The bars behind those verdicts are themselves a setting, so an operator can
ship at a looser p-value or demand a larger sample without a deploy. The
exposure property rides every PostHog event, so any funnel there breaks down
by variant as well.

## Verification

The registry, audience, assignment, experiment schema, statistics and verdict
are pure and covered by unit tests. On a dev server: create an experiment on
su with two variants and a metric and start it, load the app as two accounts
and confirm the assignment rows and the exposure event; place one account by
hand and confirm it reads that variant; hold an account out and confirm it
reads the plain configuration; compute results and confirm the verdict reads
too early.

## Source Map

The framework is the abexp package under the site's packages folder: registry
shape and resolution, audience, assignment, the experiment schema, and the
statistics and verdict, with no host code inside. The site binds it in its
config library, which holds the product's registry, collects the audience
facts, and stores assignments; the results job sits with the other background
jobs; the su surface is the experiments section with its list and settings
tabs.
