import { apId } from '@activepieces/core-utils'
import { DataSource, EntityManager } from 'typeorm'
import { z } from 'zod'
import { encryptUtils } from '../helper/encryption'
import { assertHostingOperator } from './hosting-access-policy'
import { HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL, HostedKeyAuth } from './hosting-ai-policy'
import { HostingAccountEntity } from './hosting-entities'
import { ManagedBinding, ManagedBindingEntity, ManagedModel, ManagedProfileEntity, ManagedSecretEntity } from './hosting-pricing-entities'
import { HostingActor, hostingFail, hostingTransactions as tx } from './hosting-transactions'

export const ManagedSettingsInput = z.strictObject({
    platformId: z.string().length(21).optional(), expectedRevision: z.number().int().nonnegative(), expectedGlobalRevision: z.number().int().nonnegative(),
    requestKey: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), mode: z.enum(['set', 'inherit', 'disabled']),
    model: z.enum(['inherit', HOSTED_DEEPSEEK_MODEL, HOSTED_DEEPSEEK_PRO_MODEL]), credentialAction: z.enum(['keep', 'replace', 'inherit']), apiKey: HostedKeyAuth.shape.apiKey.optional(),
})
export type ManagedSettingsInput = z.infer<typeof ManagedSettingsInput>
const scopeKey = (platformId?: string) => platformId ? `platform:${platformId}` : 'global'

export async function readManagedConfiguration(manager: EntityManager, platformId?: string, lock = false) {
    const global = await binding(manager, 'global', lock), client = platformId ? await binding(manager, scopeKey(platformId), lock) : null
    const base = global?.profileId ? await manager.getRepository(ManagedProfileEntity).findOneByOrFail({ id: global.profileId }) : null
    const override = client?.profileId ? await manager.getRepository(ManagedProfileEntity).findOneByOrFail({ id: client.profileId }) : null
    const active = override && override.mode !== 'inherit' ? override : null
    const selected = active?.model ? active : base
    const credential = active?.secretId ? active : base
    const disabled = base?.mode !== 'set' || !base.model || !base.secretId || override?.mode === 'disabled'
    const model = selected?.model ?? null
    const secretId = credential?.secretId ?? null
    return { global, client, base, override, model, secretId, modelBindingId: selected?.id ?? null, credentialBindingId: credential?.id ?? null, disabled }
}
export async function managedCredential(manager: EntityManager, platformId: string): Promise<{ apiKey: string, fingerprint: string, model: ManagedModel }> {
    const config = await readManagedConfiguration(manager, platformId, true)
    if (config.disabled || !config.model || !config.secretId) hostingFail('HOSTING_MANAGED_AI_UNAVAILABLE')
    const secret = await manager.getRepository(ManagedSecretEntity).findOneBy({ id: config.secretId })
    if (!secret) hostingFail('HOSTING_MANAGED_AI_UNAVAILABLE')
    const parsed = HostedKeyAuth.safeParse(await encryptUtils.decryptObject<unknown>(secret.auth))
    if (!parsed.success) hostingFail('HOSTING_MANAGED_AI_UNAVAILABLE')
    return { apiKey: parsed.data.apiKey, model: config.model, fingerprint: await encryptUtils.hmacString(JSON.stringify([config.global?.revision, config.model, config.modelBindingId, config.credentialBindingId, secret.id, secret.auth])) }
}
export async function saveManagedSettings({ dataSource, actor, input }: { dataSource: DataSource, actor: HostingActor, input: ManagedSettingsInput }): Promise<void> {
    const value = ManagedSettingsInput.parse(input)
    const payloadHash = await encryptUtils.hmacString(JSON.stringify(value))
    await tx.run({ dataSource, fn: async manager => {
        await assertHostingOperator({ manager, actor })
        if (value.platformId && !await manager.getRepository(HostingAccountEntity).existsBy({ id: value.platformId })) hostingFail('HOSTING_ACCOUNT_NOT_FOUND')
        const prior = await manager.getRepository(ManagedProfileEntity).findOneBy({ identityId: actor.identityId, requestKey: value.requestKey })
        if (prior) {
            if (prior.payloadHash !== payloadHash) hostingFail('HOSTING_PRICING_IDEMPOTENCY_CONFLICT')
            return
        }
        await ensureBinding(manager, 'global')
        if (value.platformId) await ensureBinding(manager, scopeKey(value.platformId))
        const global = await binding(manager, 'global', true, true)
        const current = value.platformId ? await binding(manager, scopeKey(value.platformId), true, true) : global
        if (global?.revision !== value.expectedGlobalRevision || current?.revision !== value.expectedRevision) hostingFail('HOSTING_PRICING_REVISION_CONFLICT')
        if ((!value.platformId && (value.mode === 'inherit' || value.model === 'inherit' || value.credentialAction === 'inherit')) || (value.credentialAction === 'replace') !== (value.apiKey !== undefined) || (value.mode !== 'set' && value.apiKey !== undefined)) hostingFail('HOSTING_MANAGED_SETTINGS_INVALID')
        const previous = current.profileId ? await manager.getRepository(ManagedProfileEntity).findOneByOrFail({ id: current.profileId }) : null
        let secretId = value.mode !== 'inherit' && value.credentialAction === 'keep' ? previous?.secretId ?? null : null
        if (value.mode === 'set' && value.credentialAction === 'replace') {
            secretId = apId()
            await manager.getRepository(ManagedSecretEntity).insert({ id: secretId, auth: await encryptUtils.encryptObject({ apiKey: value.apiKey }), identityId: actor.identityId })
        }
        const profile = await manager.getRepository(ManagedProfileEntity).save({ id: apId(), scopeKey: scopeKey(value.platformId), mode: value.mode, model: value.mode !== 'inherit' && value.model !== 'inherit' ? value.model : null, secretId, identityId: actor.identityId, requestKey: value.requestKey, payloadHash })
        await manager.getRepository(ManagedBindingEntity).update({ id: current.id }, { revision: current.revision + 1, profileId: profile.id })
    } })
}
export async function managedSettingsView(manager: EntityManager, platformId?: string) {
    const config = await readManagedConfiguration(manager, platformId)
    const scoped = platformId ? config.override : config.base
    return {
        scopePlatformId: platformId ?? null, revision: (platformId ? config.client : config.global)?.revision ?? 0, globalRevision: config.global?.revision ?? 0,
        mode: scoped?.mode ?? 'inherit', model: scoped?.model ?? null,
        credential: { configured: !!config.secretId, scope: !config.secretId ? 'none' as const : config.override && config.override.mode !== 'inherit' && config.override.secretId ? 'client' as const : 'global' as const, version: config.secretId },
        effective: { model: config.model, managedAvailable: !config.disabled && !!config.model && !!config.secretId, reason: config.disabled ? 'Managed AI is disabled or has no global defaults.' : !config.secretId ? 'Add a managed credential in global defaults or this client override.' : null },
    }
}
async function ensureBinding(manager: EntityManager, key: string): Promise<void> {
    await manager.getRepository(ManagedBindingEntity).createQueryBuilder().insert().values({ id: apId(), scopeKey: key, revision: 0, profileId: null }).orIgnore().execute()
}
async function binding(manager: EntityManager, key: string, lock: boolean, write = false): Promise<ManagedBinding | null> {
    return manager.getRepository(ManagedBindingEntity).findOne({ where: { scopeKey: key }, ...(lock ? { lock: { mode: write ? 'pessimistic_write' as const : 'pessimistic_read' as const } } : {}) })
}
