"""The gates on a button that moves a checkout serving production."""
from __future__ import annotations

from worker.menubar import repo
from worker.menubar.repo import Checkout

REPO = "/Users/adebolaakeredolu/Jigged"


def _co(**over) -> Checkout:
    base = dict(toplevel=REPO, branch="main", head="abc123", dirty=0,
                behind=3, ahead=0, fetched_age_s=60.0)
    base.update(over)
    return Checkout(**base)


class TestBlockers:
    def test_a_clean_main_checkout_is_allowed(self) -> None:
        assert repo.blockers(_co(), {"repo": REPO}) == []

    def test_a_feature_branch_is_named(self) -> None:
        """`git pull` here would pull the FEATURE branch's upstream, not main."""
        assert repo.blockers(_co(branch="feature/x"), {"repo": REPO}) == ["on feature/x"]

    def test_a_dirty_tree_is_named_with_a_count(self) -> None:
        assert repo.blockers(_co(dirty=4), {"repo": REPO}) == ["4 modified files"]

    def test_local_commits_block(self) -> None:
        assert repo.blockers(_co(ahead=2), {"repo": REPO}) == [
            "2 local commits not on origin/main"]

    def test_a_different_checkout_blocks(self) -> None:
        """THE WORKTREE GUARD.

        This box carries several worktrees and the plist names exactly one as the
        worker's WorkingDirectory. Pulling into the wrong one would update code the
        worker never reads, and report success.
        """
        other = "/Users/adebolaakeredolu/Jigged/.claude/worktrees/something"
        blocked = repo.blockers(_co(toplevel=other), {"repo": REPO})
        assert blocked == ["the worker runs from {}".format(REPO)]

    def test_a_failed_fetch_blocks(self) -> None:
        """Never act on a behind-count that a failed fetch could have made up."""
        assert repo.blockers(_co(), {"repo": REPO}, fetch_ok=False) == ["update check failed"]

    def test_every_reason_is_reported_not_just_the_first(self) -> None:
        blocked = repo.blockers(_co(branch="feature/x", dirty=2, ahead=1), {"repo": REPO})
        assert len(blocked) == 3

    def test_singulars_read_correctly(self) -> None:
        assert repo.blockers(_co(dirty=1), {"repo": REPO}) == ["1 modified file"]


class TestPullCommand:
    def test_it_is_never_git_pull(self) -> None:
        """`git pull` obeys branch config and can merge. --ff-only cannot."""
        cmds = repo.argv_pull(REPO)
        assert all("pull" not in c for cmd in cmds for c in cmd)

    def test_it_names_origin_main_and_refuses_a_merge(self) -> None:
        assert repo.argv_pull(REPO) == [
            ["/usr/bin/git", "-C", REPO, "merge", "--ff-only", "origin/main"]]

    def test_fetch_is_bounded_against_a_half_open_socket(self) -> None:
        """Dead Wi-Fi is the condition this app exists to show; it must not hang on it."""
        assert "http.lowSpeedLimit=1000" in repo.argv_fetch(REPO)


class TestRunningCodeIsStale:
    def test_a_pulled_but_unrestarted_worker_is_detected(self) -> None:
        """The most useful signal here, and it needs no network at all."""
        assert repo.running_code_is_stale(_co(head="new"), {"commit": "old"}) is True

    def test_a_matching_commit_is_not_stale(self) -> None:
        assert repo.running_code_is_stale(_co(head="same"), {"commit": "same"}) is False

    def test_an_unknown_commit_never_nags(self) -> None:
        """No document, or a worker too old to publish one, must not raise an alarm."""
        assert repo.running_code_is_stale(_co(), None) is False
        assert repo.running_code_is_stale(_co(), {"commit": None}) is False
