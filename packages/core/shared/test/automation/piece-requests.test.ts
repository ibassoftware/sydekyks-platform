import { ApEdition } from '../../src/lib/core/flag/flag'
import { ExactVersionType, ListPiecesRequestQuery, RegistryPiecesRequestQuery } from '../../src/lib/automation/pieces/dto/piece-requests'

describe('piece release query validation', () => {
    it.each(['0.93.0', '0.93.0-sydekyks.6', '0.93.0-beta.1', '0.93.0+build.6'])(
        'accepts platform release %s for the registry and catalogue',
        (release) => {
            expect(RegistryPiecesRequestQuery.parse({ release, edition: ApEdition.COMMUNITY }).release).toBe(release)
            expect(ListPiecesRequestQuery.parse({ release }).release).toBe(release)
        },
    )

    it.each(['', 'latest', '0.93', '^0.93.0', '0.93.0-sydekyks.01', '0.93.0;anything'])(
        'rejects invalid platform release %s',
        (release) => {
            expect(RegistryPiecesRequestQuery.safeParse({ release, edition: ApEdition.COMMUNITY }).success).toBe(false)
            expect(ListPiecesRequestQuery.safeParse({ release }).success).toBe(false)
        },
    )

    it('preserves the required registry release and edition', () => {
        expect(RegistryPiecesRequestQuery.safeParse({ edition: ApEdition.COMMUNITY }).success).toBe(false)
        expect(RegistryPiecesRequestQuery.safeParse({ release: '0.93.0' }).success).toBe(false)
        expect(RegistryPiecesRequestQuery.safeParse({ release: '0.93.0', edition: 'invalid' }).success).toBe(false)
        expect(ListPiecesRequestQuery.safeParse({}).success).toBe(true)
    })

    it('keeps connector package versions exact', () => {
        expect(ExactVersionType.safeParse('0.5.0').success).toBe(true)
        expect(ExactVersionType.safeParse('0.5.0-sydekyks.6').success).toBe(false)
        expect(ExactVersionType.safeParse('^0.5.0').success).toBe(false)
    })
})
