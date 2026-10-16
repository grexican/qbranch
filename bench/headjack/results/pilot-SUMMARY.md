# headjack skill benchmark: pilot

## claude 2.1.285 (Claude Code) · model sonnet

qbranch 7098099100 (dirty) · Windows_NT 10.0.26300 x64 · node v26.10.0 · seed hjbench-v1 · 2026-10-16
split test · sizes 25,500 · runs 1 · thresholds {"strong":0.4,"suggestMax":4,"tunedOn":"dev split (78 prompts), offline retrieval with the hook's own suggest() (src/tune.mjs), sizes 5,25,100,500","objective":"maximize recall - false-suggest (Youden J); ties to the higher threshold","grid":[{"strong":0.2,"recall":0.53,"falseSuggest":0.632,"J":-0.102},{"strong":0.25,"recall":0.449,"falseSuggest":0.355,"J":0.094},{"strong":0.3,"recall":0.407,"falseSuggest":0.25,"J":0.157},{"strong":0.35,"recall":0.347,"falseSuggest":0.132,"J":0.215},{"strong":0.4,"recall":0.288,"falseSuggest":0.066,"J":0.222},{"strong":0.45,"recall":0.208,"falseSuggest":0.066,"J":0.142},{"strong":0.5,"recall":0.169,"falseSuggest":0.053,"J":0.116},{"strong":0.55,"recall":0.136,"falseSuggest":0.026,"J":0.11}],"frozenAt":"2026-10-16T11:36:58.930Z","note":"frozen before any test-split run"} (frozen)
prompts a78ed8c816e81245 · canaries 65ca62868a998b0a · filler manifest adb16c3da4d74c22
runs: 210 recorded, 210 finished, 0 excluded (errors/timeouts)

Library composition (shard 1; other shards alike): n25: 5 target, 3 decoy, 17 public · n500: 5 target, 3 decoy, 492 public

Description cutoff (listing as received, per library): n25: 25/25/25/25/25/25/25/25 described, past-cutoff targets 0/40 · n500: 29/31/29/31/31/32/29/32 described, past-cutoff targets 37/40

| | ver | hypothesis | headjack | native | A/A gap | verdict |
|---|---|---|---|---|---|---|
| H1 | v1 | At 100+ skills, semantic prompts: headjack - native >= 15 points, intervals do not overlap | 20.0% [3.6%, 62.4%] (1/5) | 20.0% [3.6%, 62.4%] (1/5) | 0.0% | **fail** (difference 0.0% < 15 points) |
| H2 | v1 | Named-request reach (run at every size, per v2): native <= 20%, headjack >= 80% | 100.0% [51.0%, 100.0%] (4/4) | 100.0% [51.0%, 100.0%] (4/4) | 0.0% | **fail** (native reaches named skills: 100.0% > 20%) |
| H2b | v2 | Past the description cutoff, natural prompts: native <= 30%, headjack >= 70% | 17.6% [6.2%, 41.0%] (3/17) | 17.6% [6.2%, 41.0%] (3/17) | 11.8% | **fail** (headjack 17.6% < 70%) |
| H3 | v1 | At 5-25 skills, use rate: headjack >= native - 5 points | 30.0% [14.5%, 51.9%] (6/20) | 95.0% [76.4%, 99.1%] (19/20) | 0.0% | **fail** (shortfall 65.0% > 5.0%) |
| H4 | v1 | False-load rate on negatives: headjack <= native + 5 points | 25.0% [11.2%, 46.9%] (5/20) | 10.0% [2.8%, 30.1%] (2/20) | 5.0% | **fail** (shortfall 15.0% > 5.0%) |
| H5 | v1 | Given an acceptable skill was loaded, canary rate: headjack >= native - 5 points | 100.0% [74.1%, 100.0%] (11/11) | 100.0% [86.7%, 100.0%] (25/25) | 0.0% | **pass** (shortfall 0.0% <= 5.0%) |

#### Use rate by size and tier (sonnet)

| size | tier | none | native | native-again | headjack |
|---|---|---|---|---|---|
| 25 | named | 0.0% [0.0%, 65.8%] (0/2) | 100.0% [34.2%, 100.0%] (2/2) | 100.0% [34.2%, 100.0%] (2/2) | 100.0% [34.2%, 100.0%] (2/2) |
| 25 | lexical | 0.0% [0.0%, 22.8%] (0/13) | 100.0% [77.2%, 100.0%] (13/13) | 100.0% [77.2%, 100.0%] (13/13) | 23.1% [8.2%, 50.3%] (3/13) |
| 25 | semantic | 0.0% [0.0%, 43.4%] (0/5) | 80.0% [37.6%, 96.4%] (4/5) | 80.0% [37.6%, 96.4%] (4/5) | 20.0% [3.6%, 62.4%] (1/5) |
| 25 | negative (false-load) | 0.0% [0.0%, 27.8%] (0/10) | 20.0% [5.7%, 51.0%] (2/10) | 10.0% [1.8%, 40.4%] (1/10) | 30.0% [10.8%, 60.3%] (3/10) |
| 500 | named | 0.0% [0.0%, 65.8%] (0/2) | 100.0% [34.2%, 100.0%] (2/2) | 100.0% [34.2%, 100.0%] (2/2) | 100.0% [34.2%, 100.0%] (2/2) |
| 500 | lexical | 0.0% [0.0%, 22.8%] (0/13) | 23.1% [8.2%, 50.3%] (3/13) | 7.7% [1.4%, 33.3%] (1/13) | 15.4% [4.3%, 42.2%] (2/13) |
| 500 | semantic | 0.0% [0.0%, 43.4%] (0/5) | 20.0% [3.6%, 62.4%] (1/5) | 20.0% [3.6%, 62.4%] (1/5) | 20.0% [3.6%, 62.4%] (1/5) |
| 500 | negative (false-load) | 0.0% [0.0%, 27.8%] (0/10) | 0.0% [0.0%, 27.8%] (0/10) | 0.0% [0.0%, 27.8%] (0/10) | 20.0% [5.7%, 51.0%] (2/10) |

#### Load recall, follow rate, cost (sonnet, all sizes pooled, non-negative prompts)

| arm | load recall | follow rate given load | multi-answer use | mean $ / run | mean s / run | mean input+cache tokens |
|---|---|---|---|---|---|---|
| none | 0.0% [0.0%, 16.1%] (0/20) | n/a (0 runs) | 0.0% [0.0%, 79.3%] (0/1) | 0.052 | 21.8 | 40396 |
| native | 62.5% [47.0%, 75.8%] (25/40) | 100.0% [86.7%, 100.0%] (25/25) | 50.0% [9.5%, 90.5%] (1/2) | 0.085 | 24.3 | 65184 |
| native-again | 57.5% [42.2%, 71.5%] (23/40) | 100.0% [85.7%, 100.0%] (23/23) | 50.0% [9.5%, 90.5%] (1/2) | 0.084 | 23.7 | 63919 |
| headjack | 27.5% [16.1%, 42.8%] (11/40) | 100.0% [74.1%, 100.0%] (11/11) | 0.0% [0.0%, 65.8%] (0/2) | 0.057 | 26.2 | 53311 |

