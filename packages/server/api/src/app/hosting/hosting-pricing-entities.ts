import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'
import { EncryptedObject } from '../helper/encryption'
import { HostedAiPrice } from './hosting-ai-policy'
import { PricingSourceValidation } from './hosting-pricing-http'
import { PricingTerms } from './hosting-pricing-source'

type Base = { id: string, created: Date, updated: Date }
const timestamp = { type: 'timestamp with time zone' as const }
const idNullable = { ...ApIdSchema, nullable: true }
export type ManagedModel = HostedAiPrice['model']
export type PricingObservation = Base & { fence: string, state: 'verified' | 'error', terms: PricingTerms | null, termsHash: string | null, contentHash: string | null, observedAt: Date, sourceAt: Date | null, reason: string | null, sourceValidation?: PricingSourceValidation | null }
export type PricingApproval = Base & { observationId: string, termsHash: string, calendarVersion: string, identityId: string, requestKey: string, payloadHash: string, validFrom: Date, validUntil: Date }
export type PricingState = Base & { revision: number, approvalId: string | null, observationId: string | null, fetchFence: string | null, leaseUntil: Date | null, status: 'unconfigured' | 'checking' | 'ready' | 'needs_approval' | 'mismatch' | 'error' }
export type ManagedSecret = Base & { auth: EncryptedObject, identityId: string }
export type ManagedProfile = Base & { scopeKey: string, mode: 'set' | 'inherit' | 'disabled', model: ManagedModel | null, secretId: string | null, identityId: string, requestKey: string, payloadHash: string }
export type ManagedBinding = Base & { scopeKey: string, revision: number, profileId: string | null }
export const PricingObservationEntity = new EntitySchema<PricingObservation>({ name: 'hosting_pricing_observation', columns: { ...BaseColumnSchemaPart, fence: ApIdSchema, state: { type: String }, terms: { type: 'jsonb', nullable: true }, termsHash: { type: String, nullable: true }, contentHash: { type: String, nullable: true }, observedAt: timestamp, sourceAt: { ...timestamp, nullable: true }, sourceValidation: { type: 'jsonb', nullable: true }, reason: { type: String, nullable: true } } })
export const PricingApprovalEntity = new EntitySchema<PricingApproval>({ name: 'hosting_pricing_approval', columns: { ...BaseColumnSchemaPart, observationId: ApIdSchema, termsHash: { type: String }, calendarVersion: { type: String }, identityId: ApIdSchema, requestKey: { type: String, length: 120 }, payloadHash: { type: String }, validFrom: timestamp, validUntil: timestamp }, uniques: [{ columns: ['identityId', 'requestKey'] }], foreignKeys: [{ target: 'hosting_pricing_observation', columnNames: ['observationId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const PricingStateEntity = new EntitySchema<PricingState>({ name: 'hosting_pricing_state', columns: { ...BaseColumnSchemaPart, revision: { type: Number, default: 0 }, approvalId: idNullable, observationId: idNullable, fetchFence: idNullable, leaseUntil: { ...timestamp, nullable: true }, status: { type: String } }, foreignKeys: [{ target: 'hosting_pricing_approval', columnNames: ['approvalId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }, { target: 'hosting_pricing_observation', columnNames: ['observationId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const ManagedSecretEntity = new EntitySchema<ManagedSecret>({ name: 'hosting_managed_secret', columns: { ...BaseColumnSchemaPart, auth: { type: 'jsonb' }, identityId: ApIdSchema } })
export const ManagedProfileEntity = new EntitySchema<ManagedProfile>({ name: 'hosting_managed_profile', columns: { ...BaseColumnSchemaPart, scopeKey: { type: String }, mode: { type: String }, model: { type: String, nullable: true }, secretId: idNullable, identityId: ApIdSchema, requestKey: { type: String, length: 120 }, payloadHash: { type: String } }, uniques: [{ columns: ['identityId', 'requestKey'] }], foreignKeys: [{ target: 'hosting_managed_secret', columnNames: ['secretId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const ManagedBindingEntity = new EntitySchema<ManagedBinding>({ name: 'hosting_managed_binding', columns: { ...BaseColumnSchemaPart, scopeKey: { type: String, unique: true }, revision: { type: Number, default: 0 }, profileId: idNullable }, foreignKeys: [{ target: 'hosting_managed_profile', columnNames: ['profileId'], referencedColumnNames: ['id'], onDelete: 'RESTRICT' }] })
export const HOSTING_PRICING_ENTITIES = [PricingObservationEntity, PricingApprovalEntity, PricingStateEntity, ManagedSecretEntity, ManagedProfileEntity, ManagedBindingEntity]
