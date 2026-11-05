# moonshot

The showcase pipeline: 20 parts become instruction steps, each simulated in MuJoCo on a full arm-and-hand body model,
checked, and rendered in Cycles. **Strategy:** [docs/moonshot/shop-and-pipeline-plan.md](../docs/moonshot/shop-and-pipeline-plan.md).
**Tasks:** [docs/moonshot/checklist.md](../docs/moonshot/checklist.md).

```sh
conda run -n jigged pip install -r moonshot/requirements.txt   # every machine; Python 3.12
conda run -n jigged pytest moonshot                              # the fast tier, from the repo root
cd moonshot && PYTHONPATH=.. lint-imports                        # stages import only downward
python moonshot/tools/bar_check.py --base origin/main            # a PR moves the bar or meets it, never both
```

**Binaries are not in git.** CAD originals, GLBs, the parts' STEP and PDF files, the hand model, reference takes,
scene packs and the queue live in the data root (`C:\jigged-data` on the hub; `MOONSHOT_DATA` overrides it), and
code reaches them through `moonshot/config.py`. A worktree has none of them, so never read data by a path relative
to the checkout.

**The bar** is `thresholds.toml`, `tests/fixtures/`, `tests/gates/`, `reference/` and `contracts/schemas/`. A PR that
changes any of them may not change code (`tools/bar_check.py`, run in CI).

**The farm.** The hub runs `python -m moonshot.orchestrate.hub` on the Windows PC (dashboard at
http://desktop-4hvjqis:8765/). Each machine runs `python -m moonshot.orchestrate.worker`. Store a scene pack with
`python -m moonshot.orchestrate.hub put <file>`; jobs name their inputs by that sha256.

**The web page** is `/showcase`, in `app/(marketing)/showcase/`. It reads one generated file, `showcase.json`, which
`python -m moonshot.web.export` writes from the plans and records (gate: `tests/gates/test_web_steps.py`). A person's
step is shown as its video, a machine cycle as the part after the cut: one still, and on a desktop its 3D model to
turn. Models, videos and stills come
from Supabase Storage, staged first in `<data root>/web/` by `python -m moonshot.web.media models` and `stage`, then
published to the public `showcase` bucket by `upload <step> ...`, one named step at a time (a person's step only once
its draft is reviewed), which records each in `web/published.json`; the page shows only those. For development, `python -m moonshot.web.media serve --draft
takes/setup-take/draft.mp4` serves that folder, and `.env.development.local` sets
`NEXT_PUBLIC_SHOWCASE_MEDIA_URL=http://localhost:8787` and `NEXT_PUBLIC_SHOWCASE_PREVIEW_UNPUBLISHED=1`.

`library/records/` holds trainual's asset, shop and part records in trainual's own schema, the starting point for
the `jigged.resource/1` records (plan §3.2).
