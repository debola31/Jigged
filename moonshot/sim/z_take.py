"""Set Z (every VF-2 setup's step 6), run in MuJoCo on the full body at the pendant (moonshot/sim/pendant.py), from
the plan moonshot/motion/setting.py writes: the spindle probe jogged over the part's top, a Z surface cycle chosen in
VPS, started with the left hand over Feed Hold, and the shift to the setup's datum keyed in. The probe's touch is read
from the geometry each step (PendantRunner.probe_touch); test_setting_takes.py holds the work offset to the plan.

    python -m moonshot.sim.z_take nist-ftc-10 op20-z      # run, write the take record beside the plan, print the outcome
"""
from __future__ import annotations

import json
import sys

from moonshot.config import data_root
from moonshot.sim.pendant import PendantRunner


class ZTake(PendantRunner):
    pass


def main(argv: list[str]) -> None:
    folder = data_root() / "takes" / argv[0] / argv[1]
    run = ZTake(folder)
    run.run(float(argv[argv.index("--seconds") + 1]) if "--seconds" in argv else None)
    run.export(folder)
    print(json.dumps(run.outcome(), indent=1))


if __name__ == "__main__":
    main(sys.argv[1:])
