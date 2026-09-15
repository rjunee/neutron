## Rebuilt driver gate audit — bounded census

### Result and scope

Audited checkout: `fde84eca0eaedf7a715e9f5065c339a236e48d34`, branch `rebuild/gate-audit`. No fetch was attempted: this is a report about the build worktree, not a claim about a freshly fetched `origin/main` or another lane's newer commits.

**158 surviving rows enumerated: 23 CONFLICTS, 8 PRESERVED, 127 CANNOT TELL.** Only 31 rows receive a substantive conclusion. This is a partial audit, not a claim that every remaining conflict has been found. CANNOT TELL includes known items deliberately skipped, untraced integration, and gates not reached in depth.

The enumeration reads every Markdown table row beginning `| G` and selects Fate exactly equal to `keep-in-place` or `re-home-to-TS`. It yields 85 keep-in-place and 73 re-home-to-TS, rather than the brief's 86/74. Seven rows are deleted-with-the-mechanism: G002, G003, G004, G021, G116, G117, G119; the inventory explicitly describes this deletion set at `docs/trident-gates-inventory.md:57`. The classification table below contains each selected ID exactly once. It references each row, including its property, implementation, certification and loss risk; CANNOT TELL does not imply those cited bodies were all inspected.

All PRESERVED conclusions are scoped to the called driver/host gate and the supplied authoritative observations. They are not certification of deployed wiring. The host accepts injected effects (`trident/build-host.ts:25`), an admission source (`trident/build-host.ts:33`) and a review source (`trident/build-host.ts:34`). CONFLICTS names transitions those implementations permit or route differently; it does not assert that a real run was observed exploiting them. An external effect that happens to impose an additional guard is not demonstrated here.

The requested `production-host-effects.ts` and `project-build-host.ts` were not available under `trident/` in this working tree. Filesystem search, with a known-present positive control in the same invocation:

```sh
rg --files trident | rg '(^trident/(production-host-effects|project-build-host|build-host)\.ts$)'
# observed output: trident/build-host.ts
```

This is deliberately a working-tree observation, not a tracked-file absence claim. Missing source access is why effect-owned publication, cleanup and durable recovery gates remain CANNOT TELL.

**CI-PIN:** the inventory's historical CI test anchors exceed the current file. `trident/__tests__/ci-gate.test.ts:3` imports the aggregate classifier; its six tests start at lines 13, 19, 25, 31, 37 and 43, and the file ends at line 49. They cover conclusion/head classification, not required names, rulesets, grace, app binding, base comparison or pre-review ordering. The current file was read in full; `wc -l` returned 49. The same search `rg -n 'ruleset|required|grace|base|test\(' trident/__tests__/ci-gate.test.ts` matched all six test declarations as positive controls and none of the other terms. For the CI conflicts below, the old/current workflow implementation was read at the replacement line numbers given, but the historical certification bodies were unavailable at their inventory anchors. This weakens certification, not the directly visible ordering contradiction.

Known G019, G073, G076, G084, G109/G126 and G139 were not re-audited. The unnamed mode/admission findings in the brief do not provide additional gate IDs to subtract; mode integration remains explicitly uncertain. G075 and G077 are separate re-plan failure/budget boundaries, not a rediscovery of the already-known G073 allowance or G076 cap-value issue.

### Classification table

| Gate | Inventory row | Classification | Evidence or unresolved boundary |
| --- | --- | --- | --- |
| G001 | `docs/trident-gates-inventory.md:65` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G005 | `docs/trident-gates-inventory.md:69` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G006 | `docs/trident-gates-inventory.md:70` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G007 | `docs/trident-gates-inventory.md:71` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G008 | `docs/trident-gates-inventory.md:72` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G009 | `docs/trident-gates-inventory.md:73` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G010 | `docs/trident-gates-inventory.md:74` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G011 | `docs/trident-gates-inventory.md:75` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G012 | `docs/trident-gates-inventory.md:76` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G013 | `docs/trident-gates-inventory.md:77` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G014 | `docs/trident-gates-inventory.md:78` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G015 | `docs/trident-gates-inventory.md:79` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G016 | `docs/trident-gates-inventory.md:80` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G017 | `docs/trident-gates-inventory.md:81` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G018 | `docs/trident-gates-inventory.md:82` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G019 | `docs/trident-gates-inventory.md:83` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G020 | `docs/trident-gates-inventory.md:89` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G022 | `docs/trident-gates-inventory.md:91` | PRESERVED | Completed is the only runner outcome reaching corroboration; null/unmatched envelopes fail (trident/build-run.ts:245; trident/build-run.ts:255). Current checks: trident/build-run.test.ts:80 and trident/build-run.test.ts:88. This covers the bounded-result boundary, not CLI transport implementation. |
| G023 | `docs/trident-gates-inventory.md:92` | CONFLICTS | See G023 below; `trident/build-run.ts:127`. |
| G024 | `docs/trident-gates-inventory.md:93` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G025 | `docs/trident-gates-inventory.md:94` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G026 | `docs/trident-gates-inventory.md:95` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G027 | `docs/trident-gates-inventory.md:96` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G028 | `docs/trident-gates-inventory.md:97` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G029 | `docs/trident-gates-inventory.md:98` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G030 | `docs/trident-gates-inventory.md:99` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G031 | `docs/trident-gates-inventory.md:100` | PRESERVED | A null completed builder result fails corroboration before review (trident/build-run.ts:127; trident/build-run.ts:255). Direct malformed-result fixture: trident/build-run.test.ts:80. |
| G032 | `docs/trident-gates-inventory.md:101` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G033 | `docs/trident-gates-inventory.md:102` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G034 | `docs/trident-gates-inventory.md:103` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G035 | `docs/trident-gates-inventory.md:104` | CONFLICTS | See G035 below; `trident/build-run.ts:320`. |
| G036 | `docs/trident-gates-inventory.md:105` | CONFLICTS | See G036 below; `trident/build-run.ts:182`. |
| G037 | `docs/trident-gates-inventory.md:106` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G038 | `docs/trident-gates-inventory.md:107` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G039 | `docs/trident-gates-inventory.md:108` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G040 | `docs/trident-gates-inventory.md:109` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G041 | `docs/trident-gates-inventory.md:110` | CANNOT TELL | Mode/measurement integration or historical certification not fully traced; driver mode callbacks are declared at trident/build-run.ts:61 and optional at trident/build-run.ts:92. |
| G042 | `docs/trident-gates-inventory.md:111` | CONFLICTS | See G042 below; `trident/build-run.ts:347`. |
| G043 | `docs/trident-gates-inventory.md:112` | CONFLICTS | See G043 below; `trident/build-run.ts:347`. |
| G044 | `docs/trident-gates-inventory.md:118` | CONFLICTS | See G044 below; `trident/build-run.ts:320`. |
| G045 | `docs/trident-gates-inventory.md:119` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G046 | `docs/trident-gates-inventory.md:120` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G047 | `docs/trident-gates-inventory.md:121` | CONFLICTS | See G047 below; `trident/build-run.ts:320`. |
| G048 | `docs/trident-gates-inventory.md:122` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G049 | `docs/trident-gates-inventory.md:123` | CONFLICTS | See G049 below; `trident/build-host.ts:124`. |
| G050 | `docs/trident-gates-inventory.md:124` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G051 | `docs/trident-gates-inventory.md:125` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G052 | `docs/trident-gates-inventory.md:126` | CONFLICTS | See G052 below; `trident/build-run.ts:320`. |
| G053 | `docs/trident-gates-inventory.md:127` | CONFLICTS | See G053 below; `trident/build-run.ts:320`. |
| G054 | `docs/trident-gates-inventory.md:128` | CONFLICTS | See G054 below; `trident/build-run.ts:320`. |
| G055 | `docs/trident-gates-inventory.md:129` | CONFLICTS | See G055 below; `trident/build-host.ts:126`. |
| G056 | `docs/trident-gates-inventory.md:130` | CONFLICTS | See G056 below; `trident/gates/review-panel.ts:101`. |
| G057 | `docs/trident-gates-inventory.md:131` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G058 | `docs/trident-gates-inventory.md:132` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G059 | `docs/trident-gates-inventory.md:133` | PRESERVED | readReviewSeat retries a deferred/missing observation once; completed and rate-limited observations do not enter that retry (trident/gates/review-panel.ts:48). Called for each enabled seat at trident/gates/review-panel.ts:69; differentiated statuses tested at trident/gates/review-panel.test.ts:51. |
| G060 | `docs/trident-gates-inventory.md:134` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G061 | `docs/trident-gates-inventory.md:135` | PRESERVED | Unknown severity fails schema validation; empty rejection blocks; nonempty minor/nit findings can approve (trident/gates/result-contract.ts:93; trident/gates/review-panel.ts:85; trident/gates/review-panel.ts:99). Current cases: trident/gates/review-panel.test.ts:72 and trident/gates/review-panel.test.ts:104. |
| G062 | `docs/trident-gates-inventory.md:136` | PRESERVED | unmarked removes advisory and reserved lane/suite kinds from worker, seat and synthesis findings before validation/arithmetic (trident/gates/review-panel.ts:36; trident/gates/review-panel.ts:61; trident/gates/review-panel.ts:73; trident/gates/review-panel.ts:79). Tests exercise both seat and synthesis at trident/gates/review-panel.test.ts:90. |
| G063 | `docs/trident-gates-inventory.md:137` | CONFLICTS | See G063 below; `trident/build-run.ts:261`. |
| G064 | `docs/trident-gates-inventory.md:138` | CONFLICTS | See G064 below; `trident/build-run.ts:322`. |
| G065 | `docs/trident-gates-inventory.md:139` | CONFLICTS | See G065 below; `trident/build-run.ts:322`. |
| G066 | `docs/trident-gates-inventory.md:140` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G067 | `docs/trident-gates-inventory.md:141` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G068 | `docs/trident-gates-inventory.md:147` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G069 | `docs/trident-gates-inventory.md:148` | PRESERVED | APPROVE plus escalation is refused by claim validation and blocked before panel approval (trident/gates/escalation.ts:85; trident/gates/review-panel.ts:89). Direct contradictory-verdict cases: trident/gates/review-panel.test.ts:85. |
| G070 | `docs/trident-gates-inventory.md:149` | CONFLICTS | See G070 below; `trident/build-run.ts:341`. |
| G071 | `docs/trident-gates-inventory.md:150` | CONFLICTS | See G071 below; `trident/build-run.ts:338`. |
| G072 | `docs/trident-gates-inventory.md:151` | CANNOT TELL | Panel logic inspected, but exact prior outcome taxonomy/configuration equivalence not established; host returns blocked/unknown through trident/gates/review-panel.ts:32 and trident/build-run.ts:149. |
| G073 | `docs/trident-gates-inventory.md:152` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G074 | `docs/trident-gates-inventory.md:153` | PRESERVED | A valid missing-dependency declaration yields a stop, which reviewPanel returns as blocked and buildRun returns immediately (trident/gates/escalation.ts:140; trident/gates/escalation.ts:152; trident/gates/review-panel.ts:90; trident/build-run.ts:323). Direct case: trident/gates/review-panel.test.ts:118. Durable board routing is not included in this preservation finding. |
| G075 | `docs/trident-gates-inventory.md:154` | CONFLICTS | See G075 below; `trident/build-run.ts:269`. |
| G076 | `docs/trident-gates-inventory.md:155` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G077 | `docs/trident-gates-inventory.md:156` | CONFLICTS | See G077 below; `trident/build-run.ts:326`. |
| G078 | `docs/trident-gates-inventory.md:157` | PRESERVED | Escalation is evaluated before minor/nit approval and blocked decisions stop the driver (trident/gates/review-panel.ts:87; trident/gates/review-panel.ts:101; trident/build-run.ts:323). This establishes refusal to continue/merge, not preservation of the durable escalation payload. |
| G079 | `docs/trident-gates-inventory.md:158` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G080 | `docs/trident-gates-inventory.md:159` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G081 | `docs/trident-gates-inventory.md:160` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G082 | `docs/trident-gates-inventory.md:161` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G083 | `docs/trident-gates-inventory.md:167` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G084 | `docs/trident-gates-inventory.md:168` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G085 | `docs/trident-gates-inventory.md:169` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G086 | `docs/trident-gates-inventory.md:170` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G087 | `docs/trident-gates-inventory.md:171` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G088 | `docs/trident-gates-inventory.md:172` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G089 | `docs/trident-gates-inventory.md:173` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G090 | `docs/trident-gates-inventory.md:174` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G091 | `docs/trident-gates-inventory.md:175` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G092 | `docs/trident-gates-inventory.md:176` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G093 | `docs/trident-gates-inventory.md:177` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G094 | `docs/trident-gates-inventory.md:178` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G095 | `docs/trident-gates-inventory.md:179` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G096 | `docs/trident-gates-inventory.md:180` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G097 | `docs/trident-gates-inventory.md:181` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G098 | `docs/trident-gates-inventory.md:182` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G099 | `docs/trident-gates-inventory.md:183` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G100 | `docs/trident-gates-inventory.md:184` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G101 | `docs/trident-gates-inventory.md:185` | CONFLICTS | See G101 below; `trident/build-run.ts:320`. |
| G102 | `docs/trident-gates-inventory.md:186` | CONFLICTS | See G102 below; `trident/build-run.ts:129`. |
| G103 | `docs/trident-gates-inventory.md:187` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G104 | `docs/trident-gates-inventory.md:193` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G105 | `docs/trident-gates-inventory.md:194` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G106 | `docs/trident-gates-inventory.md:195` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G107 | `docs/trident-gates-inventory.md:196` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G108 | `docs/trident-gates-inventory.md:197` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G109 | `docs/trident-gates-inventory.md:198` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G110 | `docs/trident-gates-inventory.md:199` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G111 | `docs/trident-gates-inventory.md:200` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G112 | `docs/trident-gates-inventory.md:201` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G113 | `docs/trident-gates-inventory.md:202` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G114 | `docs/trident-gates-inventory.md:203` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G115 | `docs/trident-gates-inventory.md:204` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G118 | `docs/trident-gates-inventory.md:207` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G120 | `docs/trident-gates-inventory.md:209` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G121 | `docs/trident-gates-inventory.md:210` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G122 | `docs/trident-gates-inventory.md:211` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G123 | `docs/trident-gates-inventory.md:212` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G124 | `docs/trident-gates-inventory.md:213` | CONFLICTS | See G124 below; `trident/build-run.ts:397`. |
| G125 | `docs/trident-gates-inventory.md:214` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G126 | `docs/trident-gates-inventory.md:215` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G127 | `docs/trident-gates-inventory.md:216` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G128 | `docs/trident-gates-inventory.md:217` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G129 | `docs/trident-gates-inventory.md:218` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G130 | `docs/trident-gates-inventory.md:219` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G131 | `docs/trident-gates-inventory.md:220` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G132 | `docs/trident-gates-inventory.md:226` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G133 | `docs/trident-gates-inventory.md:227` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G134 | `docs/trident-gates-inventory.md:228` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G135 | `docs/trident-gates-inventory.md:229` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G136 | `docs/trident-gates-inventory.md:230` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G137 | `docs/trident-gates-inventory.md:231` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G138 | `docs/trident-gates-inventory.md:232` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G139 | `docs/trident-gates-inventory.md:233` | CANNOT TELL | Known conflict from the task brief; deliberately skipped, not certified repaired. |
| G140 | `docs/trident-gates-inventory.md:234` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G141 | `docs/trident-gates-inventory.md:240` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G142 | `docs/trident-gates-inventory.md:241` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G143 | `docs/trident-gates-inventory.md:242` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G144 | `docs/trident-gates-inventory.md:243` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G145 | `docs/trident-gates-inventory.md:244` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G146 | `docs/trident-gates-inventory.md:245` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G147 | `docs/trident-gates-inventory.md:246` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G148 | `docs/trident-gates-inventory.md:247` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G149 | `docs/trident-gates-inventory.md:248` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G150 | `docs/trident-gates-inventory.md:249` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G151 | `docs/trident-gates-inventory.md:250` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G152 | `docs/trident-gates-inventory.md:251` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G153 | `docs/trident-gates-inventory.md:252` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G154 | `docs/trident-gates-inventory.md:253` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G155 | `docs/trident-gates-inventory.md:254` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G156 | `docs/trident-gates-inventory.md:255` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G157 | `docs/trident-gates-inventory.md:256` | CANNOT TELL | Cleanup owner/reachability not established for replacement effects. Driver ends with catch at trident/build-run.ts:397; old cleanup is in finally at trident/inner-workflow.mjs:6983. Do not infer preservation from the script existing. |
| G158 | `docs/trident-gates-inventory.md:257` | CANNOT TELL | Publication/merge effect or claim-source internals not fully traced. Effects are injected at trident/build-host.ts:25; readiness/proof calls at trident/build-host.ts:114 are not proof of effect behavior. |
| G159 | `docs/trident-gates-inventory.md:258` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |
| G160 | `docs/trident-gates-inventory.md:259` | CANNOT TELL | Required-check acquisition/base comparison details not certified. The aggregate CI boundary is trident/ci-readiness.ts:3; historical certification anchors are stale (CI-PIN). |
| G161 | `docs/trident-gates-inventory.md:265` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G162 | `docs/trident-gates-inventory.md:266` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G163 | `docs/trident-gates-inventory.md:267` | CANNOT TELL | Delegated prover internals and cited certification bodies not audited. Call site is wired at trident/build-host.ts:116; that alone does not certify this subgate. |
| G164 | `docs/trident-gates-inventory.md:268` | CANNOT TELL | Durable outer admission/harvest/recovery/board integration and its certification not audited; createBuildHost delegates execution at trident/build-host.ts:141. No preservation conclusion from retained code alone. |
| G165 | `docs/trident-gates-inventory.md:269` | CANNOT TELL | Prompt generation or helper production reachability not audited; prepareWork is an injected effect (trident/build-run.ts:93; trident/build-host.ts:25). |

### Conflict details

#### G023 — Builder branch claims must match the assigned branch.

Inventory: `docs/trident-gates-inventory.md:92`. Contradiction: `trident/build-run.ts:127`. Corroboration compares only head, diff and PR; a completed envelope can carry a different branch in its payload and still reach review (trident/build-run.ts:255; trident/build-run.ts:261).

Lost: The explicit branch-disagreement refusal is lost even when the reported commit is valid.

Comparison evidence: trident/inner-workflow.mjs:1810; trident/inner-workflow-gates.test.ts:149.

#### G035 — Fresh review needs a built head and a nonempty diff artifact.

Inventory: `docs/trident-gates-inventory.md:104`. Contradiction: `trident/build-run.ts:320`. After build, review is dispatched without a nonempty-diff predicate; corroboration accepts equal empty strings (trident/build-run.ts:129; trident/build-run.ts:288; trident/build-run.ts:304).

Lost: A paid panel can review no change before later publication gates refuse it.

Comparison evidence: trident/inner-workflow.mjs:6371; trident/inner-workflow-built-head.test.ts:229.

#### G036 — A confirmed merged PR ends work before another round.

Inventory: `docs/trident-gates-inventory.md:105`. Contradiction: `trident/build-run.ts:182`. A fresh run with any PR is blocked, including MERGED; after a completed build the driver advances to review, while the explicit merged confirmation is after its own merge effect (trident/build-run.ts:320; trident/build-run.ts:393).

Lost: Already-landed work can be blocked or reviewed again instead of being recognized as done.

Comparison evidence: trident/inner-workflow.mjs:6310; trident/round-landed.test.ts:168.

#### G042 — An unchanged post-fix head ends the round before another review, after checking for a merge.

Inventory: `docs/trident-gates-inventory.md:111`. Contradiction: `trident/build-run.ts:347`. A completed fix returns to the for-loop review without comparing the pre-fix and post-fix heads; the immutability comparison is restricted to the review role (trident/build-run.ts:257; trident/build-run.ts:319).

Lost: A fix that commits nothing can buy another panel.

Comparison evidence: trident/inner-workflow.mjs:6710; trident/inner-workflow.mjs:6718; trident/round-landed.test.ts:76; trident/round-landed.test.ts:149.

#### G043 — A fix that leaves no diff stops before another paid review.

Inventory: `docs/trident-gates-inventory.md:112`. Contradiction: `trident/build-run.ts:347`. The fix result updates the snapshot and the loop dispatches review even when its diff is empty (trident/build-run.ts:260; trident/build-run.ts:320).

Lost: A panel can spend a round approving an erased change.

Comparison evidence: trident/inner-workflow.mjs:6741; trident/inner-workflow-built-head.test.ts:314.

#### G044 — Unknown required-check configuration defers review.

Inventory: `docs/trident-gates-inventory.md:118`. Contradiction: `trident/build-run.ts:320`. The driver dispatches review before its composed host observes CI, which is called only by mergeGate (trident/build-host.ts:113; trident/build-host.ts:124).

Lost: Unreadable protection no longer prevents spending the review round.

Comparison evidence: trident/inner-workflow.mjs:3826; trident/inner-workflow.mjs:4834; CI-PIN in the scope section.

#### G047 — Review waits for readable PR data and MERGEABLE status.

Inventory: `docs/trident-gates-inventory.md:121`. Contradiction: `trident/build-run.ts:320`. Review dispatch precedes publish; BuildSnapshot carries OPEN/CLOSED/MERGED but no mergeability observation (trident/build-run.ts:26; trident/build-run.ts:371).

Lost: Conflicting or not-yet-measurable PR state cannot defer this paid review.

Comparison evidence: trident/inner-workflow.mjs:3860; trident/inner-workflow.mjs:3864; CI-PIN in the scope section.

#### G049 — All required checks must have run and settled before review.

Inventory: `docs/trident-gates-inventory.md:123`. Contradiction: `trident/build-host.ts:124`. CI is observed at merge after the driver has spent review; the observation type supplies one aggregate conclusion rather than named check rows (trident/build-run.ts:320; trident/ci-readiness.ts:3).

Lost: Missing, skipped or running required checks cannot hold review at the original boundary.

Comparison evidence: trident/inner-workflow.mjs:3940; trident/inner-workflow.mjs:3943; CI-PIN in the scope section.

#### G052 — Even without named requirements, a check must run and all participating checks must settle.

Inventory: `docs/trident-gates-inventory.md:126`. Contradiction: `trident/build-run.ts:320`. An initially unpublished snapshot can reach review; the no-run decision is consulted only later in mergeGate (trident/build-host.ts:124; trident/ci-readiness.ts:25).

Lost: Zero-check work can spend the panel budget.

Comparison evidence: trident/inner-workflow.mjs:3958; trident/inner-workflow.mjs:3960; CI-PIN in the scope section.

#### G053 — Readiness waits use a 900000-ms budget and 30000-ms cadence without spending review rounds.

Inventory: `docs/trident-gates-inventory.md:127`. Contradiction: `trident/build-run.ts:320`. The review call runs immediately at this transition; the later CI observation returns a blocked or unknown gate directly (trident/build-host.ts:124; trident/build-host.ts:126).

Lost: Readiness loses its dedicated bounded wait before paid work.

Comparison evidence: trident/inner-workflow.mjs:3361; trident/inner-workflow.mjs:3362; trident/inner-workflow.mjs:3972; CI-PIN in the scope section.

#### G054 — Settled pass or failure may enter review; conflicting, unknown and configuration-error states may not.

Inventory: `docs/trident-gates-inventory.md:128`. Contradiction: `trident/build-run.ts:320`. The transition dispatches the review worker before any composed CI gate; a downstream merge refusal occurs after that expenditure (trident/build-host.ts:124).

Lost: Review admission loses the distinction between repairable red and unreviewable state.

Comparison evidence: trident/inner-workflow.mjs:3976; trident/inner-workflow.mjs:3981; CI-PIN in the scope section.

#### G055 — New red CI forces rejection; a matching base failure becomes advisory.

Inventory: `docs/trident-gates-inventory.md:129`. Contradiction: `trident/build-host.ts:126`. The composed path handles red as a merge block after the panel decision; reviewPanel can approve based on seats and checkpoint alone (trident/gates/review-panel.ts:100; trident/gates/review-panel.ts:101). CiRunObservation does not carry base comparison or finding identities (trident/ci-readiness.ts:3).

Lost: New CI failures do not automatically feed actionable findings into the code-fix loop.

Comparison evidence: trident/inner-workflow.mjs:5382; trident/inner-workflow.mjs:5554; CI-PIN in the scope section.

#### G056 — Pending or unreadable CI prevents review approval through the deferred-peer gate.

Inventory: `docs/trident-gates-inventory.md:130`. Contradiction: `trident/gates/review-panel.ts:101`. Panel approval depends on panel observations, while CI is read later by mergeGate (trident/build-host.ts:113; trident/build-host.ts:124).

Lost: A pending CI state can coexist with an approved review and publication; a later merge hold is a different boundary.

Comparison evidence: trident/inner-workflow.mjs:5580; CI-PIN in the scope section.

#### G063 — With a supplied test strategy, an unproven full suite blocks; only dispatched subset work earns deferral.

Inventory: `docs/trident-gates-inventory.md:137`. Contradiction: `trident/build-run.ts:261`. Builder payload becomes previousPayload for prepareWork, but reviewGate receives the review payload and snapshot, not the builder suite evidence or dispatched suite scope (trident/build-run.ts:242; trident/build-run.ts:322). The composed panel approves from verdicts alone (trident/gates/review-panel.ts:101).

Lost: A valid build envelope reporting not-run can still obtain approval without the independent suite override.

Comparison evidence: trident/inner-workflow.mjs:4685; trident/inner-workflow.mjs:4708; trident/inner-workflow.mjs:6434; trident/inner-workflow-assembly.test.ts:1358.

#### G064 — testsPassed=true plus an explicit non-passed suite outcome is contradictory and must block.

Inventory: `docs/trident-gates-inventory.md:138`. Contradiction: `trident/build-run.ts:322`. The review gate does not receive the build report; Forge schema fields validate boolean and enum shapes separately (trident/gates/result-contract.ts:147; trident/gates/result-contract.ts:149), while the panel can return approve (trident/gates/review-panel.ts:101).

Lost: Contradictory suite evidence no longer deterministically overrides an approving panel.

Comparison evidence: trident/inner-workflow.mjs:4687; trident/inner-workflow-assembly.test.ts:1351.

#### G065 — A pre-existing-red suite excuse needs nonempty base comparison evidence.

Inventory: `docs/trident-gates-inventory.md:139`. Contradiction: `trident/build-run.ts:322`. The composed panel sees no builder suiteEvidence argument and can approve from its own recorded verdicts (trident/gates/review-panel.ts:60; trident/gates/review-panel.ts:101).

Lost: An empty failed-preexisting claim loses its independent blocker even if reviewers all approve.

Comparison evidence: trident/inner-workflow.mjs:4709; trident/inner-workflow.mjs:4711; trident/inner-workflow-assembly.test.ts:1273.

#### G070 — A repeated actionable finding across a fix round stops independently of reviewer declarations.

Inventory: `docs/trident-gates-inventory.md:149`. Contradiction: `trident/build-run.ts:341`. The repeated-finding stop is gated on round >= 3, so repetition on the second review buys another fix. The shared escalation function is called with a declaration but without previous/current findings (trident/gates/review-panel.ts:89).

Lost: The first proven repeat is tolerated for an additional paid fix/review cycle.

Comparison evidence: trident/inner-workflow.mjs:6508; trident/gates/escalation.ts:53; trident/__tests__/escalation-gate.test.ts:544.

#### G071 — Two readable code rounds with nondecreasing blocker/major counts trigger no-progress escalation.

Inventory: `docs/trident-gates-inventory.md:150`. Contradiction: `trident/build-run.ts:338`. The count comparison runs only after a re-plan. Without one, the driver uses repeat identities and the ceiling; reviewPanel supplies no blockingCounts to decideEscalation (trident/build-run.ts:341; trident/gates/review-panel.ts:89).

Lost: Changing finding identities can spend extra rounds despite a flat or rising blocker count.

Comparison evidence: trident/inner-workflow.mjs:6482; trident/inner-workflow.mjs:6511; trident/gates/escalation.ts:72; trident/__tests__/escalation-gate.test.ts:466.

#### G075 — A failed bounded re-plan escalates without rebuilding against unusable planning output.

Inventory: `docs/trident-gates-inventory.md:154`. Contradiction: `trident/build-run.ts:269`. planAndBuild validates planner payloads only for Ralph/wave. For PR mode, a completed envelope with null payload or empty executionSpec proceeds into build, including when invoked for a re-plan (trident/build-run.ts:288; trident/build-run.ts:334).

Lost: The replacement can rebuild after its attempted new plan produced no usable execution spec.

Comparison evidence: trident/inner-workflow.mjs:6589; trident/inner-workflow.mjs:6597; trident/inner-workflow-gates.test.ts:199.

#### G077 — A design gap at the last allowed round becomes a stop when no re-plan round remains.

Inventory: `docs/trident-gates-inventory.md:156`. Contradiction: `trident/build-run.ts:326`. The re-plan arm calls planAndBuild and continues before reaching the round-ceiling check (trident/build-run.ts:334; trident/build-run.ts:341). This differs from the already-known issue of where the cap value comes from.

Lost: A last-round design gap can spend an extra planner, builder and review instead of escalating.

Comparison evidence: trident/inner-workflow.mjs:6784; trident/__tests__/escalation-e2e.test.ts:408; trident/__tests__/escalation-e2e.test.ts:435.

#### G101 — Confirm an open PR before handing work to review.

Inventory: `docs/trident-gates-inventory.md:185`. Contradiction: `trident/build-run.ts:320`. Review precedes the publish effect; the first explicit post-publication OPEN check is at the merge transition (trident/build-run.ts:371; trident/build-run.ts:377).

Lost: Paid review can finish before PR creation succeeds.

Comparison evidence: trident/orchestrator.ts:2733; trident/orchestrator.ts:2741; the cited historical test body was not separately revalidated.

#### G102 — Review dispatch requires a readable nonempty base-to-head change and its materialized artifact.

Inventory: `docs/trident-gates-inventory.md:186`. Contradiction: `trident/build-run.ts:129`. Matching empty diff strings corroborate successfully and fresh execution then dispatches review; the driver does not require a nonempty diff here (trident/build-run.ts:255; trident/build-run.ts:320).

Lost: The outer review-dispatch empty-change refusal is lost as well as the inner G035 check.

Comparison evidence: trident/orchestrator.ts:2862; the cited historical test body was not separately revalidated.

#### G124 — A thrown workflow produces a typed failure with no verdict or task continuation.

Inventory: `docs/trident-gates-inventory.md:213`. Contradiction: `trident/build-run.ts:397`. The catch maps every exception to nonterminal unknown, including a prepareWork throw before a worker is launched (trident/build-run.ts:242; trident/build-run.ts:399). The unknown outcome is documented as preserving a worker rather than reaping it (trident/build-run.ts:118).

Lost: A definite pre-dispatch failure loses the workflow-threw terminal classification; its durable resolution is unverified.

Comparison evidence: trident/inner-workflow.mjs:6952; trident/inner-workflow.mjs:6957; trident/inner-workflow.mjs:6970; trident/inner-workflow.test.ts:1831.

### Search controls and interpretation limits

These content searches were executed over the named replacement files. Positive controls are in the same search, not a second unrelated query:

```sh
rg -n 'round-lost|no.progress|blockingCounts|reviewReadiness|ciReadiness|reviewGate|planAndBuild|finally|cleanup' trident/build-run.ts trident/build-host.ts trident/gates/*.ts
rg -n 'finally|cleanup|worktreeCleanup|buildRun|fullSuiteFindings|testsPassed|suiteOutcome|observeCi|panel-single-family|log.warn' trident/build-run.ts trident/build-host.ts trident/gates/review-panel.ts trident/gates/result-contract.ts
```

The first finds `reviewGate` at `trident/build-run.ts:322`, CI at `trident/build-host.ts:124`, and `blockingCounts` inside `trident/gates/escalation.ts:106`; its cleanup/finally hits are scratch-diff/test cleanup, including `trident/gates/release-readiness.ts:81`. The second finds `observeCi` at `trident/build-host.ts:124`, schema-only `testsPassed` at `trident/gates/result-contract.ts:147`, and the leak log at `trident/build-run.ts:356`. It does not find the old suite helper or run cleanup in those files. These searches establish spelling-specific absence in the inspected scope; the full control-flow reads supply the conflict conclusions. They do not exclude unseen behavior inside injected workers or host effects.

### Decisions, vocabulary and remaining uncertainty

The unit of counting is an inventory gate, not a root cause. G035/G102 and the readiness group share transition defects but protect separately inventoried boundaries. Their counts must not be interpreted as independent fixes.

The replacement's result vocabulary distinguishes `blocked`, `failed` and nonterminal `unknown` (`trident/build-run.ts:111`). Gate failures are converted directly to blocked/unknown (`trident/build-run.ts:149`), and a caught throw defaults to unknown (`trident/build-run.ts:397`). This is the specific default behind G124. No claim is made that unknown becomes a particular board lane: the durable adapter was not traced. Likewise, a preserved refusal in reviewPanel does not prove preservation of `design-gap`, `not-converging`, `infra-only`, or their payloads in storage.

The shared escalation helper still computes repeat/no-progress (`trident/gates/escalation.ts:102`), but its called review seam supplies declaration fields only (`trident/gates/review-panel.ts:89`). Existence of the helper therefore cannot certify G070/G071. The generic driver count check depends on an already-spent re-plan (`trident/build-run.ts:338`), leaving the ordinary arithmetic boundary different.

Cleanup is especially unresolved: the old finally executes the deterministic script independently of the builder result (`trident/inner-workflow.mjs:6983`); no equivalent owner was established around the injected replacement effects (`trident/build-host.ts:25`). G125/G127 and delegated cleanup rows remain CANNOT TELL instead of being guessed preserved or declaring global absence. The same restraint applies to watchdogs, retry claims, lease enforcement, merge atomicity and every prover subgate. This report adds no invariant or guard and claims no new continuous enforcement.

### Validation and deliverable boundaries

Read `docs/process/work-tracking.md` before investigation and again before finalizing this record. Used the task's explicitly required `.trident/as-built/rebuild/gate-audit.md` destination rather than creating a second record. Production code, tests, inventory, spec decisions and dependencies were deliberately not edited. No fixes, pushes, PR creation or merge were attempted.

Targeted command executed:

```sh
bun test trident/build-run.test.ts trident/gates/review-panel.test.ts trident/__tests__/ci-gate.test.ts
```

Result: **111 pass, 0 fail, 400 assertions**. This is a sanity check on existing tests, not proof of gate preservation. The G042 contradiction is illustrated by the green unchanged-head fixture: `trident/build-run.test.ts:6` creates one head, `trident/build-run.test.ts:30` keeps measuring it, and `trident/build-run.test.ts:44` expects fix then review 2 and merge. The review-panel tests cited in PRESERVED rows directly call the same policy reached by `trident/build-host.ts:113`; they do not exercise production provider wiring.

| New guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| None — report only | Not applicable | Not performed | Not performed |

No tests were added, weakened or mutated. No full test suite was run. `bash scripts/ci/typecheck-all.sh` completed with exit 1: 51 configurations checked, 50 passed, and `app/tsconfig.json` failed with TS2688, missing type definition file `@types`. The trident configuration passed. This report-only change does not repair that dependency/typecheck failure. The root scripts contain no typecheck or lint alias (`package.json:57`); the repository typecheck command is documented at `CONTRIBUTING.md:79`. No executable lint target was changed. Report validation checks exact inventory-ID coverage, one `## ` heading, whitespace, and that only this document is staged.

`bash scripts/ci/leak-gate.sh --tree .` completed with exit 3: zero findings from executed rules, but `pii-denylist` and `pii-denylist-msg` could not run because the private denylist was unavailable. This is INCOMPLETE, not a clean leak certification. The report also passed a local restricted-text check. Commit-message scan reported zero message lines, so this run does not certify the subsequent commit message.
