# R-23 seed: this is the analysis script from the 2026-09-09 wall-clock audit.
# It reads ~/.forge/fleet.jsonl and ~/.forge/console/queue.jsonl and prints
# per-item hop medians, run/bash-time stats, council counts, gate/warden signals.
import json, collections, os, glob, statistics, re, sys
H = os.path.expanduser('~')
F = os.path.join(H, '.forge')

def load(path):
    out = []
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            try: out.append(json.loads(line))
            except: pass
    return out

fleet = load(os.path.join(F, 'fleet.jsonl'))
fleet.sort(key=lambda e: e.get('at', 0))
qrows = load(os.path.join(F, 'console', 'queue.jsonl'))

def fmt(ms):
    if ms is None: return '-'
    s = ms / 1000
    if s < 90: return f'{s:.0f}s'
    m = s / 60
    if m < 90: return f'{m:.1f}m'
    return f'{m/60:.1f}h'

# ---------- A. queue items ----------
items = collections.OrderedDict()
hist = collections.defaultdict(list)
for r in qrows:
    it = items.setdefault(r['id'], {})
    it.update({k: v for k, v in r.items() if v is not None})
    hist[r['id']].append(r)

merge_calls = [e for e in fleet if e.get('event') == 'external.call' and e.get('kind') == 'pr-merge']
by_item_events = collections.defaultdict(list)
for e in fleet:
    if 'itemId' in e: by_item_events[e['itemId']].append(e)

print('=== A. QUEUE ITEMS (created since 2026-09-07) ===')
print(f"{'item':11} {'src':7} {'repo':22} {'plan':>6} {'launch':>7} {'work':>7} {'review->end':>11} {'total':>7} parks relaunch pend state")
rows = []
for iid, it in items.items():
    if it.get('createdAt', 0) < 1788760000000: continue  # ~2026-09-07
    h = hist[iid]
    t_created = it.get('createdAt')
    t_planning = next((r['at'] for r in h if r.get('state') == 'planning'), None)
    t_running = next((r['at'] for r in h if r.get('state') == 'running'), None)
    t_launch = next((r['at'] for r in h if r.get('runKey')), None)
    t_review = next((r['at'] for r in h if r.get('state') == 'review'), None)
    t_end = next((r['at'] for r in h if r.get('state') in ('done',) or r.get('removedAt')), None)
    ev = by_item_events[iid]
    parks = sum(1 for e in ev if e['event'] == 'queue.parked')
    relaunch = sum(1 for e in ev if e['event'] == 'queue.relaunch-on-retry')
    pend = sum(1 for e in ev if e['event'] == 'queue.pending-checks')
    def d(a, b): return (b - a) if a and b else None
    rows.append((iid, it.get('source', '?')[:7], (it.get('repo') or '?')[-22:], d(t_planning, t_running), d(t_running, t_launch), d(t_launch, t_review), d(t_review, t_end), d(t_created, t_end), parks, relaunch, pend, it.get('state')))
for r in rows:
    print(f"{r[0]:11} {r[1]:7} {r[2]:22} {fmt(r[3]):>6} {fmt(r[4]):>7} {fmt(r[5]):>7} {fmt(r[6]):>11} {fmt(r[7]):>7} {r[8]:5} {r[9]:8} {r[10]:4} {r[11]}")
def med(xs):
    xs = [x for x in xs if x]
    return fmt(statistics.median(xs)) if xs else '-'
print('MEDIANS plan/launch/work/review->end/total:', med([r[3] for r in rows]), med([r[4] for r in rows]), med([r[5] for r in rows]), med([r[6] for r in rows]), med([r[7] for r in rows]))
print('count', len(rows), 'states', collections.Counter(r[11] for r in rows))

# ---------- B. runs ----------
print('\n=== B. RUNS ===')
runs = collections.defaultdict(lambda: {'tools': 0, 'bash': [], 'turns': 0, 'start': None, 'end': None, 'handoffs': 0, 'verdict': None, 'model': None, 'cls': None, 'usage': None, 'parked': 0, 'verifyfail': 0})
open_tool = {}
for e in fleet:
    r = e.get('run')
    if not r: continue
    R = runs[r]
    ev = e['event']
    if ev == 'run.started':
        R['start'] = e['at']; R['model'] = e.get('model'); R['cls'] = e.get('className')
    elif ev == 'run.finished':
        R['end'] = e['at']; R['verdict'] = e.get('verdict')
    elif ev == 'tool.start':
        R['tools'] += 1; open_tool[r] = (e['at'], e.get('tool'))
    elif ev == 'tool.end':
        if r in open_tool:
            st, tool = open_tool.pop(r)
            if tool == 'Bash': R['bash'].append(e['at'] - st)
    elif ev == 'turn.end': R['turns'] += 1
    elif ev == 'run.handoff': R['handoffs'] += 1
    elif ev == 'run.parked': R['parked'] += 1
    elif ev == 'run.verify-failed': R['verifyfail'] += 1
    elif ev == 'result.usage': R['usage'] = e.get('modelUsage')
qruns = {k: v for k, v in runs.items() if k.startswith('queue-') and v['start']}
print('queue runs:', len(qruns))
durs = [v['end'] - v['start'] for v in qruns.values() if v['end']]
print('run duration median', med(durs), 'p90', fmt(sorted(durs)[int(len(durs) * .9)]) if durs else '-')
print('tools per run median', statistics.median([v['tools'] for v in qruns.values()]))
allbash = [b for v in qruns.values() for b in v['bash']]
print('bash calls', len(allbash), 'median', med(allbash), 'sum', fmt(sum(allbash)))
long = [b for b in allbash if b > 60000]
print('bash calls >60s:', len(long), 'sum', fmt(sum(long)), ' >120s:', sum(1 for b in allbash if b > 120000), fmt(sum(b for b in allbash if b > 120000)))
print('share of run wall clock in bash>60s:', f"{sum(long)/sum(durs)*100:.0f}%" if durs else '-')
print('handoffs total', sum(v['handoffs'] for v in qruns.values()), 'runs with handoff', sum(1 for v in qruns.values() if v['handoffs']))
print('verify-failed events', sum(v['verifyfail'] for v in qruns.values()))
print('verdicts', collections.Counter(v['verdict'] for v in qruns.values()))
print('classes', collections.Counter(v['cls'] for v in qruns.values()))
print('\nTop 12 runs by wall clock:')
for k, v in sorted(qruns.items(), key=lambda kv: -((kv[1]['end'] or kv[1]['start']) - kv[1]['start']))[:12]:
    print(f"  {k:45} {fmt((v['end'] or v['start'])-v['start']):>6} tools={v['tools']:4} bash>60s={sum(1 for b in v['bash'] if b>60000):3} bashsum={fmt(sum(v['bash'])):>6} turns={v['turns']:4} handoffs={v['handoffs']} verdict={v['verdict']}")

# ---------- C. council ----------
print('\n=== C. COUNCIL ===')
prs = collections.defaultdict(lambda: {'lens': 0, 'judge': 0, 'attest': 0, 'first': None, 'last': None, 'heads': set()})
for e in fleet:
    ev = e['event']
    if ev.startswith('council.') and e.get('pr'):
        k = (e.get('repo'), e['pr']); P = prs[k]
        P['first'] = P['first'] or e['at']; P['last'] = e['at']
        if ev == 'council.lens': P['lens'] += 1
        elif ev == 'council.judge': P['judge'] += 1
        elif ev == 'council.attested': P['attest'] += 1; P['heads'].add(e.get('head'))
print('PRs councilled', len(prs))
print('lens per PR', collections.Counter(p['lens'] for p in prs.values()))
print('judge per PR', collections.Counter(p['judge'] for p in prs.values()))
print('attestations per PR', collections.Counter(p['attest'] for p in prs.values()))
print('PRs with >1 distinct attested head:', sum(1 for p in prs.values() if len(p['heads']) > 1))
rc = [e for e in fleet if e['event'] == 'reasoner.call']
byc = collections.defaultdict(list)
for e in rc: byc[e.get('class')].append(e.get('durationMs') or 0)
print('reasoner.call by class: count / median / total')
for c, xs in byc.items(): print(f"  {c:12} {len(xs):4} {med(xs):>6} {fmt(sum(xs)):>6}")
# codex lane
cx = [e for e in fleet if 'codex' in json.dumps(e).lower() and e['event'].startswith('council')]
print('council events mentioning codex:', len(cx), collections.Counter(e['event'] for e in cx))
ext = collections.Counter((e['event'], e.get('kind')) for e in fleet if e['event'].startswith('external.'))
print('external:', dict(ext))

# ---------- D. gate ----------
print('\n=== D. GATE / MERGE ===')
print('queue.parked by hop', collections.Counter(e.get('hop') for e in fleet if e['event'] == 'queue.parked'))
print('queue.failed by hop', collections.Counter(e.get('hop') for e in fleet if e['event'] == 'queue.failed'))
print('pending-checks', sum(1 for e in fleet if e['event'] == 'queue.pending-checks'))
print('unverified-pr', sum(1 for e in fleet if e['event'] == 'queue.unverified-pr'))
print('self.merge-refused reasons', collections.Counter(e.get('reason', '')[:60] for e in fleet if e['event'] == 'self.merge-refused').most_common(8))

# ---------- E. warden / rounds / noise ----------
print('\n=== E. WARDEN / ROUNDS ===')
print('warden.parked by signal', collections.Counter(e.get('signal') for e in fleet if e['event'] == 'warden.parked'))
print('liveness.stuck by signal', collections.Counter(e.get('signal') for e in fleet if e['event'] == 'liveness.stuck'))
print('run.parked reasons', collections.Counter(re.sub(r'[0-9a-f]{16}', 'K', (e.get('reason') or ''))[:50] for e in fleet if e['event'] == 'run.parked').most_common(8))
print('permission.denied reasons', collections.Counter((e.get('reason') or '')[:60] for e in fleet if e['event'] == 'permission.denied').most_common(6))
ra = [e for e in fleet if e['event'] == 'rounds.applied']
print('rounds.applied', len(ra), 'sample', json.dumps(ra[-1])[:300] if ra else '')
bm = [e for e in fleet if e['event'] == 'burn.mismatch']
if bm:
    gaps = [b['at'] - a['at'] for a, b in zip(bm, bm[1:])]
    print('burn.mismatch', len(bm), 'median gap', med(gaps))
# events per hour lately
last = fleet[-1]['at']
recent = [e for e in fleet if e['at'] > last - 6 * 3600 * 1000]
print('events in last 6h', len(recent), collections.Counter(e['event'] for e in recent).most_common(10))
