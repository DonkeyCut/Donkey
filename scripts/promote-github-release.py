#!/usr/bin/env python3
from __future__ import annotations

import argparse
import email.utils
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Sequence
from xml.sax.saxutils import escape


SEMVER_RE = re.compile(r"^v?(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)$")
LATEST_VERSION_RE = re.compile(r'export const DONKEY_LATEST_VERSION = "[^"]+";')


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @property
    def bare(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    @property
    def tag(self) -> str:
        return f"v{self.bare}"

    @property
    def major_tag(self) -> str:
        return f"v{self.major}"

    @property
    def minor_tag(self) -> str:
        return f"v{self.major}.{self.minor}"


@dataclass(frozen=True)
class ReleaseAsset:
    download_url: str
    size: int


@dataclass(frozen=True)
class Release:
    asset: ReleaseAsset
    html_url: str
    release_id: int
    published_at: str


@dataclass(frozen=True)
class RetentionRelease:
    version: Version
    tag_name: str
    release_id: int


def run(command: Sequence[str], *, dry_run: bool = False, mutate: bool = False) -> str:
    if dry_run and mutate:
        print(f"dry-run: {' '.join(command)}")
        return ""

    completed = subprocess.run(command, check=True, text=True, capture_output=True)
    return completed.stdout.strip()


def current_branch() -> str:
    branch = run(["git", "branch", "--show-current"])
    if not branch:
        raise ValueError("cannot push promoted files from a detached HEAD")

    return branch


def push_current_branch(branch: str, dry_run: bool) -> None:
    if dry_run:
        print(f"dry-run: git fetch origin {branch}:refs/remotes/origin/{branch}")
        print(f"dry-run: git rebase origin/{branch}")
        print(f"dry-run: git push origin HEAD:{branch}")
        return

    run(["git", "fetch", "origin", f"{branch}:refs/remotes/origin/{branch}"])
    run(["git", "rebase", f"origin/{branch}"])

    try:
        run(["git", "push", "origin", f"HEAD:{branch}"])
    except subprocess.CalledProcessError:
        run(["git", "fetch", "origin", f"{branch}:refs/remotes/origin/{branch}"])
        run(["git", "rebase", f"origin/{branch}"])
        run(["git", "push", "origin", f"HEAD:{branch}"])


def subprocess_error_message(exc: subprocess.CalledProcessError) -> str:
    lines = [f"command {exc.cmd!r} exited with status {exc.returncode}"]
    if exc.stdout:
        lines.append(f"stdout:\n{exc.stdout.strip()}")
    if exc.stderr:
        lines.append(f"stderr:\n{exc.stderr.strip()}")

    return "\n".join(lines)


def parse_version(raw_version: str) -> Version:
    match = SEMVER_RE.match(raw_version.strip())
    if not match:
        raise ValueError("version must be numeric SemVer in MAJOR.MINOR.PATCH form, with an optional v prefix")

    return Version(
        major=int(match.group("major")),
        minor=int(match.group("minor")),
        patch=int(match.group("patch")),
    )


def numeric_release_version(tag_name: str) -> Version | None:
    try:
        return parse_version(tag_name)
    except ValueError:
        return None


def load_release(repo: str, tag: str, asset_name: str) -> Release:
    payload = run(["gh", "api", f"repos/{repo}/releases/tags/{tag}"])
    data = json.loads(payload)

    for asset in data.get("assets", []):
        if asset.get("name") == asset_name:
            return Release(
                asset=ReleaseAsset(
                    download_url=str(asset["browser_download_url"]),
                    size=int(asset["size"]),
                ),
                html_url=str(data["html_url"]),
                release_id=int(data["id"]),
                published_at=str(data.get("published_at") or data.get("created_at") or ""),
            )

    raise ValueError(f"release {tag} does not have an asset named {asset_name}")


def load_retention_releases(repo: str) -> list[RetentionRelease]:
    payload = run(["gh", "api", "--paginate", "--slurp", f"repos/{repo}/releases"])
    pages = json.loads(payload)
    if not isinstance(pages, list):
        raise ValueError("GitHub releases response was not a list")

    raw_releases: list[dict] = []
    for page in pages:
        if isinstance(page, list):
            raw_releases.extend(item for item in page if isinstance(item, dict))
        elif isinstance(page, dict):
            raw_releases.append(page)

    releases: list[RetentionRelease] = []
    for release in raw_releases:
        if release.get("prerelease") is True:
            continue

        tag_name = str(release.get("tag_name") or "")
        version = numeric_release_version(tag_name)
        if version is None:
            continue

        releases.append(
            RetentionRelease(
                version=version,
                tag_name=tag_name,
                release_id=int(release["id"]),
            )
        )

    return sorted(releases, key=lambda release: release.version, reverse=True)


def release_pub_date(published_at: str) -> str:
    if published_at:
        parsed = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
    else:
        parsed = datetime.now(UTC)

    return email.utils.format_datetime(parsed.astimezone(UTC), usegmt=True)


def write_release_constants(path: Path, version: Version) -> None:
    source = path.read_text(encoding="utf-8")
    replacement = f'export const DONKEY_LATEST_VERSION = "{version.bare}";'

    if LATEST_VERSION_RE.search(source):
        next_source = LATEST_VERSION_RE.sub(replacement, source, count=1)
    else:
        anchor = 'export const GITHUB_REPO_URL = "https://github.com/DonkeyUseCorp/Donkey";'
        next_source = source.replace(anchor, f"{anchor}\n{replacement}", 1)

    path.write_text(next_source, encoding="utf-8")


def write_appcast(path: Path, version: Version, build: str, signature: str, release: Release) -> None:
    appcast = f'''<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Donkey Updates</title>
    <link>https://donkeycut.com/appcast.xml</link>
    <description>Donkey macOS app updates.</description>
    <language>en</language>
    <item>
      <title>Version {escape(version.bare)}</title>
      <sparkle:releaseNotesLink>{escape(release.html_url)}</sparkle:releaseNotesLink>
      <pubDate>{release_pub_date(release.published_at)}</pubDate>
      <enclosure
        url="{escape(release.asset.download_url)}"
        sparkle:version="{escape(build)}"
        sparkle:shortVersionString="{escape(version.bare)}"
        sparkle:minimumSystemVersion="14.0"
        sparkle:edSignature="{escape(signature)}"
        length="{release.asset.size}"
        type="application/x-apple-diskimage" />
    </item>
  </channel>
</rss>
'''
    path.write_text(appcast, encoding="utf-8")


def promote_tags(version: Version, promote_major: bool, promote_minor: bool, promote_latest: bool, dry_run: bool) -> None:
    aliases: list[str] = []
    if promote_major:
        aliases.append(version.major_tag)
    if promote_minor:
        aliases.append(version.minor_tag)
    if promote_latest:
        aliases.append("latest")

    if not aliases:
        return

    target = run(["git", "rev-list", "-n", "1", version.tag], dry_run=dry_run) if not dry_run else version.tag
    for alias in aliases:
        run(["git", "tag", "-f", alias, target], dry_run=dry_run, mutate=True)
        run(["git", "push", "origin", f"refs/tags/{alias}", "--force"], dry_run=dry_run, mutate=True)


def commit_promoted_files(paths: Sequence[Path], version: Version, dry_run: bool) -> None:
    string_paths = [str(path) for path in paths]
    if dry_run:
        print(f"dry-run: git add {' '.join(string_paths)}")
        print(f"dry-run: git commit -m Promote Donkey {version.tag}")
        push_current_branch(current_branch(), dry_run=True)
        return

    run(["git", "add", *string_paths])
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if diff.returncode == 0:
        print("No website or appcast changes to commit.")
        return
    if diff.returncode != 1:
        diff.check_returncode()

    run(["git", "commit", "-m", f"Promote Donkey {version.tag}"])
    push_current_branch(current_branch(), dry_run=False)


def mark_release_latest(repo: str, release: Release, dry_run: bool) -> None:
    run(
        [
            "gh",
            "api",
            "-X",
            "PATCH",
            f"repos/{repo}/releases/{release.release_id}",
            "-f",
            "make_latest=true",
        ],
        dry_run=dry_run,
        mutate=True,
    )


def prune_old_releases(repo: str, keep_releases: int, dry_run: bool) -> None:
    if keep_releases < 1:
        raise ValueError("keep releases must be at least 1")

    releases = load_retention_releases(repo)
    stale_releases = releases[keep_releases:]
    if not stale_releases:
        print(f"Release retention: found {len(releases)} production releases; nothing to delete.")
        return

    print(
        "Release retention: "
        f"keeping latest {keep_releases} production releases and deleting {len(stale_releases)} older releases."
    )
    for release in stale_releases:
        run(
            [
                "gh",
                "api",
                "-X",
                "DELETE",
                f"repos/{repo}/releases/{release.release_id}",
            ],
            dry_run=dry_run,
            mutate=True,
        )
        action = "Would delete" if dry_run else "Deleted"
        print(f"{action} GitHub Release {release.tag_name}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote a numeric Donkey GitHub Release for site downloads and Sparkle.")
    parser.add_argument("--repo", required=True, help="GitHub repository in owner/name form.")
    parser.add_argument("--version", required=True, help="Numeric release version, for example 0.1.0 or v0.1.0.")
    parser.add_argument("--build", required=True, help="CFBundleVersion build number used by Sparkle.")
    parser.add_argument("--sparkle-ed-signature", required=True, help="Sparkle EdDSA signature for the release asset.")
    parser.add_argument("--asset-name", default="Donkey.dmg", help="Release asset to use for downloads and Sparkle.")
    parser.add_argument("--release-constants", default="site/src/app/_components/landing/data.ts")
    parser.add_argument("--appcast", default="site/public/appcast.xml")
    parser.add_argument("--promote-major", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--promote-minor", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--promote-latest", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--keep-releases", type=int, default=10, help="Keep this many latest numeric production releases.")
    parser.add_argument("--commit", action="store_true", help="Commit and push website/appcast changes before moving aliases.")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.keep_releases < 1:
        raise ValueError("keep releases must be at least 1")

    version = parse_version(args.version)
    if version.tag.endswith("-latest"):
        raise ValueError("promoted website versions must be numeric and must not use a -latest tag")

    release = load_release(args.repo, version.tag, args.asset_name)
    release_constants = Path(args.release_constants)
    appcast = Path(args.appcast)

    write_release_constants(release_constants, version)
    write_appcast(appcast, version, args.build, args.sparkle_ed_signature, release)
    if args.commit:
        commit_promoted_files([release_constants, appcast], version, args.dry_run)

    promote_tags(version, args.promote_major, args.promote_minor, args.promote_latest, args.dry_run)
    if args.promote_latest:
        mark_release_latest(args.repo, release, args.dry_run)
    prune_old_releases(args.repo, args.keep_releases, args.dry_run)

    print(f"Promoted {version.tag}")
    print(f"Download URL: {release.asset.download_url}")
    print("Website release URL uses the numeric tag, not a moving alias.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"promote-github-release: {subprocess_error_message(exc)}", file=sys.stderr)
        raise SystemExit(1)
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"promote-github-release: {exc}", file=sys.stderr)
        raise SystemExit(1)
