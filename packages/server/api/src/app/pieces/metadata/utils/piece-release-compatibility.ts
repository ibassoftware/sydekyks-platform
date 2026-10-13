import semVer from 'semver'

function baseVersion({ release }: { release: string }): string {
    return semVer.parse(release)?.prerelease[0] === 'sydekyks' ? semVer.coerce(release)?.version ?? release : release
}

export const pieceReleaseCompatibility = { baseVersion }
