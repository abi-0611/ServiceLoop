# -*- coding: utf-8 -*-
"""Generates the four committed Grafana dashboards (phase 7.4).

Written as a generator rather than four hand-maintained 800-line JSON files
because Grafana's dashboard JSON is 90% boilerplate and 10% queries, and a
reviewer cannot see the queries in the noise. The output is committed; this
script is kept so a fifth panel is a two-line diff rather than a JSON edit.
"""
import json
import os

OUT = 'infra/grafana/dashboards'
os.makedirs(OUT, exist_ok=True)

DS = {'type': 'prometheus', 'uid': '${DS_PROMETHEUS}'}


def panel(title, targets, unit='short', kind='timeseries', x=0, y=0, w=12, h=8, description=''):
    return {
        'type': kind,
        'title': title,
        'description': description,
        'datasource': DS,
        'gridPos': {'h': h, 'w': w, 'x': x, 'y': y},
        'fieldConfig': {
            'defaults': {'unit': unit, 'custom': {'lineWidth': 2, 'fillOpacity': 8}},
            'overrides': [],
        },
        'options': {'legend': {'displayMode': 'table', 'placement': 'bottom', 'calcs': ['lastNotNull', 'max']}},
        'targets': [
            {'datasource': DS, 'expr': expr, 'legendFormat': legend, 'refId': chr(65 + index)}
            for index, (expr, legend) in enumerate(targets)
        ],
    }


def stat(title, expr, unit='short', x=0, y=0, w=6, h=4, description='', thresholds=None):
    p = panel(title, [(expr, '')], unit=unit, kind='stat', x=x, y=y, w=w, h=h, description=description)
    p['options'] = {'reduceOptions': {'calcs': ['lastNotNull']}, 'colorMode': 'value'}
    if thresholds:
        p['fieldConfig']['defaults']['thresholds'] = {
            'mode': 'absolute',
            'steps': [{'color': c, 'value': v} for c, v in thresholds],
        }
    return p


def dashboard(uid, title, description, panels, tags):
    return {
        '__inputs': [],
        'uid': uid,
        'title': title,
        'description': description,
        'tags': ['serviceloop', *tags],
        'timezone': 'browser',
        'schemaVersion': 39,
        'version': 1,
        'refresh': '30s',
        'time': {'from': 'now-6h', 'to': 'now'},
        'templating': {
            'list': [
                {
                    'name': 'DS_PROMETHEUS',
                    'type': 'datasource',
                    'query': 'prometheus',
                    'current': {'text': 'Prometheus', 'value': 'Prometheus'},
                    'hide': 0,
                }
            ]
        },
        'panels': panels,
    }


# --------------------------------------------------------------- system health
system = dashboard(
    'sl-system-health',
    'ServiceLoop — System health',
    'The first dashboard to open during an incident. Reads top-left to '
    'bottom-right in the order the questions get asked: is anything leaving the '
    'system, is the queue draining, are the providers answering, is the '
    'database alive.',
    [
        stat(
            'Oldest unsent outbox row',
            'serviceloop_outbox_oldest_pending_seconds',
            unit='s', x=0, y=0, w=6, h=4,
            description='The single most important number here. Everything customer-facing leaves through the outbox, so this climbing means messages are not being sent — and it climbs before anybody complains.',
            thresholds=[('green', None), ('yellow', 30), ('red', 60)],
        ),
        stat('Outbox backlog', 'sum(serviceloop_outbox_backlog)', x=6, y=0, w=6, h=4),
        stat(
            'Dead-lettered (1h)',
            'sum(increase(serviceloop_dead_lettered_total[1h]))',
            x=12, y=0, w=6, h=4,
            description='Growth matters, not depth: a DLQ that has been at forty for a week is triaged; forty new rows in ten minutes is a handler failing on live traffic.',
            thresholds=[('green', None), ('yellow', 1), ('red', 5)],
        ),
        stat(
            'Webhook error rate',
            'sum(rate(serviceloop_webhook_requests_total{outcome="error"}[5m])) / clamp_min(sum(rate(serviceloop_webhook_requests_total[5m])), 0.001)',
            unit='percentunit', x=18, y=0, w=6, h=4,
            description='Meta and Razorpay retry 5xx and eventually give up. Sustained failure loses inbound customer messages permanently.',
            thresholds=[('green', None), ('yellow', 0.02), ('red', 0.1)],
        ),
        panel(
            'Queue depth',
            [('serviceloop_queue_depth', '{{queue}} · {{state}}')],
            x=0, y=4, w=12,
            description='Waiting jobs per queue. A single queue climbing while the rest are flat is a slow handler; all of them climbing is a stopped worker.',
        ),
        panel(
            'Queue lag',
            [('serviceloop_queue_lag_seconds', '{{queue}}')],
            unit='s', x=12, y=4, w=12,
            description='Age of the oldest waiting job. Depth without lag is a burst; lag without depth is one stuck job.',
        ),
        panel(
            'Job throughput',
            [('sum by (queue, outcome) (rate(serviceloop_queue_jobs_processed_total[5m]))', '{{queue}} · {{outcome}}')],
            unit='ops', x=0, y=12, w=12,
        ),
        panel(
            'Job duration p95',
            [('histogram_quantile(0.95, sum by (le, queue) (rate(serviceloop_queue_job_duration_seconds_bucket[5m])))', '{{queue}}')],
            unit='s', x=12, y=12, w=12,
        ),
        panel(
            'Outbox dispatch',
            [
                ('sum(rate(serviceloop_outbox_dispatched_total[5m]))', 'dispatched'),
                ('sum(rate(serviceloop_outbox_failed_total[5m]))', 'failed'),
                ('sum(rate(serviceloop_outbox_parked_total[5m]))', 'parked'),
            ],
            unit='ops', x=0, y=20, w=24,
            description='Parked rows are the ones that exhausted their attempts. A non-zero parked rate is data loss unless somebody replays it.',
        ),
    ],
    ['ops'],
)

# ------------------------------------------------------------ conversation funnel
funnel = dashboard(
    'sl-conversation-funnel',
    'ServiceLoop — Conversation funnel',
    'What the product is actually doing: messages in, messages out, what the '
    'gate refused and why. The blocked-by-reason panel is the most useful thing '
    'on this dashboard and the least obvious — a rising CONSENT_REVOKED is the '
    'system working, and a rising WINDOW_CLOSED_NEEDS_TEMPLATE is an outage.',
    [
        panel(
            'Outbound sends',
            [('sum by (channel, purpose) (rate(serviceloop_outbound_sent_total[10m]))', '{{channel}} · {{purpose}}')],
            unit='ops', x=0, y=0, w=12,
        ),
        panel(
            'Blocked by the OutboundGate',
            [('sum by (code) (rate(serviceloop_outbound_blocked_total[10m]))', '{{code}}')],
            unit='ops', x=12, y=0, w=12,
            description='Refusals by reason. CONSENT_REVOKED rising is the guardrail working. WINDOW_CLOSED_NEEDS_TEMPLATE rising means a template was paused or rejected — an outage nobody notices until a shop asks why their customers went quiet.',
        ),
        panel(
            'Escalation rung delay p95',
            [('histogram_quantile(0.95, sum by (le, objective) (rate(serviceloop_ladder_rung_delay_seconds_bucket[30m])))', '{{objective}}')],
            unit='s', x=0, y=8, w=12,
            description='How late a rung fired against its scheduled time. The load test asserts drift under five seconds; sustained drift here means the escalation worker is behind.',
        ),
        panel(
            'Calls by outcome',
            [('sum by (direction, outcome) (rate(serviceloop_calls_total[30m]))', '{{direction}} · {{outcome}}')],
            unit='ops', x=12, y=8, w=12,
        ),
        panel(
            'Voice turn latency p95',
            [('histogram_quantile(0.95, rate(serviceloop_voice_turn_latency_seconds_bucket[10m]))', 'p95')],
            unit='s', x=0, y=16, w=12,
            description='Customer silence to first audio. Above about 1.2s a caller starts talking over the agent.',
        ),
        panel(
            'Speech latency by stage p95',
            [('histogram_quantile(0.95, sum by (le, stage) (rate(serviceloop_speech_latency_seconds_bucket[10m])))', '{{stage}}')],
            unit='s', x=12, y=16, w=12,
            description='Which of the three stages is slow. Debugging dead air without this split is guesswork.',
        ),
    ],
    ['product'],
)

# ---------------------------------------------------------------------- cost
cost = dashboard(
    'sl-cost',
    'ServiceLoop — Cost',
    'What the product spends, per hour, split by the three things that cost '
    'money: the model, the channel and the telephone. Every figure is an integer '
    'of the smallest unit; nothing here is a float.',
    [
        stat(
            'Model spend (USD/hour)',
            'sum(rate(serviceloop_llm_cost_usd_micros_total[1h])) * 3600 / 1e6',
            unit='currencyUSD', x=0, y=0, w=8, h=4,
        ),
        stat(
            'Channel spend (₹/hour)',
            'sum(rate(serviceloop_channel_cost_paise_total[1h])) * 3600 / 100',
            unit='currencyINR', x=8, y=0, w=8, h=4,
        ),
        stat(
            'Model error rate',
            'sum(rate(serviceloop_llm_calls_total{outcome="error"}[10m])) / clamp_min(sum(rate(serviceloop_llm_calls_total[10m])), 0.001)',
            unit='percentunit', x=16, y=0, w=8, h=4,
            thresholds=[('green', None), ('yellow', 0.02), ('red', 0.05)],
        ),
        panel(
            'Model spend by task class',
            [('sum by (task_class) (rate(serviceloop_llm_cost_usd_micros_total[10m])) * 3600 / 1e6', '{{task_class}}')],
            unit='currencyUSD', x=0, y=4, w=12,
            description='By task class, not by model: the question an owner asks is "what is the agent costing me", and the answer changes when a model id changes.',
        ),
        panel(
            'Model latency p95',
            [('histogram_quantile(0.95, sum by (le, task_class) (rate(serviceloop_llm_latency_seconds_bucket[10m])))', '{{task_class}}')],
            unit='s', x=12, y=4, w=12,
        ),
        panel(
            'Channel spend by category',
            [('sum by (channel, category) (rate(serviceloop_channel_cost_paise_total[1h])) * 3600 / 100', '{{channel}} · {{category}}')],
            unit='currencyINR', x=0, y=12, w=12,
            description='MARKETING conversations cost roughly seven times a UTILITY one on the India card. A month that costs more than the last is usually this panel, not volume.',
        ),
        panel(
            'Channel failover',
            [('sum by (state) (increase(serviceloop_channel_failover_total[1h]))', '{{state}}')],
            x=12, y=12, w=12,
            description='Circuit-breaker transitions. Every DOWN here is a period in which sends went over SMS, which costs money per message where WhatsApp costs per conversation.',
        ),
    ],
    ['cost'],
)

# ---------------------------------------------------------------- guardrails
guardrails = dashboard(
    'sl-guardrails',
    'ServiceLoop — Guardrails & compliance',
    'The dashboard nobody looks at until somebody asks a hard question, which '
    'is exactly why it is committed. Audit-chain integrity, DPDP request '
    'throughput, and the refusals that prove the consent gate is doing its job.',
    [
        stat(
            'Chain verifications broken (24h)',
            'sum(increase(serviceloop_audit_chain_verifications_total{outcome="broken"}[24h]))',
            x=0, y=0, w=8, h=4,
            description='There is no acceptable non-zero value. Either the chain writer has a bug or rows have been modified outside the application.',
            thresholds=[('green', None), ('red', 1)],
        ),
        stat(
            'Data requests overdue',
            'serviceloop_data_requests_overdue',
            x=8, y=0, w=8, h=4,
            description='Approved DPDP requests past their scheduled execution time. A statutory clock; nothing else in the system would notice one stuck.',
            thresholds=[('green', None), ('red', 1)],
        ),
        stat(
            'Blocked sends (1h)',
            'sum(increase(serviceloop_outbound_blocked_total[1h]))',
            x=16, y=0, w=8, h=4,
        ),
        panel(
            'Audit chain verifications',
            [('sum by (outcome) (increase(serviceloop_audit_chain_verifications_total[1h]))', '{{outcome}}')],
            x=0, y=4, w=12,
        ),
        panel(
            'DPDP requests',
            [('sum by (kind, status) (increase(serviceloop_data_requests_total[24h]))', '{{kind}} · {{status}}')],
            x=12, y=4, w=12,
        ),
        panel(
            'Refusals by purpose and flow',
            [('sum by (purpose, flow) (rate(serviceloop_outbound_blocked_total[30m]))', '{{purpose}} · {{flow}}')],
            unit='ops', x=0, y=12, w=24,
            description='Retention traffic refused by the frequency floor and the service-recovery freeze shows up here. A flat zero on the retention flow means the floor is not being reached, which is either a quiet month or a broken reader.',
        ),
    ],
    ['compliance'],
)

for name, board in [
    ('system-health.json', system),
    ('conversation-funnel.json', funnel),
    ('cost.json', cost),
    ('guardrails.json', guardrails),
]:
    path = os.path.join(OUT, name)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(board, handle, indent=2)
        handle.write('\n')
    print('wrote', path)
