"""Pick task ids without reading them: python pick.py 5 --seed 20261104 [--exclude-prepared]

A seeded sample of the 200 ids, so the subset is fixed in advance and not chosen by looking at tasks.
--exclude-prepared samples only from ids that have no work/ folder yet, to extend an earlier sample.
"""

import argparse
import random

from common import WORK, task_ids


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("count", type=int)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--exclude-prepared", action="store_true")
    args = parser.parse_args()
    ids = task_ids()
    if args.exclude_prepared and WORK.exists():
        ids = [i for i in ids if not (WORK / i).exists()]
    print(" ".join(sorted(random.Random(args.seed).sample(ids, args.count))))


if __name__ == "__main__":
    main()
