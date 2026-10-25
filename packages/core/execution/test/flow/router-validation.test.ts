import { describe, expect, it } from 'vitest'
import { BranchExecutionType, RouterActionSettings, RouterActionSettingsWithValidation, RouterExecutionType } from '../../src/lib/flows/actions/action'

const settings = (conditions: unknown) => ({
    executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
    branches: [
        { branchType: BranchExecutionType.CONDITION, branchName: 'Qualified', conditions },
        { branchType: BranchExecutionType.FALLBACK, branchName: 'Otherwise' },
    ],
})
const condition = { firstValue: "{{step_1['output'].category}}", operator: 'TEXT_EXACTLY_MATCHES', secondValue: 'qualified' }

describe('router condition validation', () => {
    it.each([[], [[]], [[condition], []]].map(conditions => ({ conditions })))('stores incomplete draft conditions $conditions but does not validate them', ({ conditions }) => {
        expect(RouterActionSettings.safeParse(settings(conditions)).success).toBe(true)
        expect(RouterActionSettingsWithValidation.safeParse(settings(conditions)).success).toBe(false)
    })

    it('validates nonempty OR groups and AND conditions', () => {
        expect(RouterActionSettingsWithValidation.safeParse(settings([[condition], [{ firstValue: 'override', operator: 'EXISTS' }]])).success).toBe(true)
    })

    it('preserves fallback branches without conditions', () => {
        expect(RouterActionSettingsWithValidation.safeParse({
            executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
            branches: [{ branchType: BranchExecutionType.FALLBACK, branchName: 'Otherwise' }],
        }).success).toBe(true)
    })
})
