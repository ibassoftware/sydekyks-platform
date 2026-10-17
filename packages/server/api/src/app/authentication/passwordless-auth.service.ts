import { ActivepiecesError, apId, ErrorCode, isNil } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { ApFlagId, OtpType, TelemetryEvent, TelemetryEventName, UserIdentity, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { QueryFailedError } from 'typeorm'
import { databaseConnection } from '../database/database-connection'
import { flagService } from '../flags/flag.service'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { telemetry } from '../helper/telemetry.utils'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { hostingServices } from '../hosting/hosting-services'
import { hostingTransactions } from '../hosting/hosting-transactions'
import { platformService } from '../platform/platform.service'
import { userService } from '../user/user-service'
import { userInvitationsService } from '../user-invitations/user-invitation.service'
import { AuthenticationResult, authenticationUtils } from './authentication-utils'
import { authenticationService } from './authentication.service'
import { passwordHasher } from './lib/password-hasher'
import { signupNames } from './lib/signup-names'
import { turnstile } from './lib/turnstile'
import { zerobounce } from './lib/zerobounce'
import { otpService } from './otp/otp-service'
import { UserIdentityEntity } from './user-identity/user-identity-entity'
import { userIdentityService } from './user-identity/user-identity-service'

export const passwordlessAuthService = (log: FastifyBaseLogger) => ({
    async requestCode({ email, platformId, captchaToken, remoteIp, strictCaptcha = false }: RequestCodeParams): Promise<void> {
        await turnstile.assertSolved({ token: captchaToken, remoteIp, log, failClosed: strictCaptcha })
        const existingIdentity = await userIdentityService(log).getIdentityByEmail(email)
        if (isNil(existingIdentity)) {
            const maySignUp = await zerobounce.maySignUp({ email, log })
            if (!maySignUp) {
                return
            }
        }
        if (!isNil(platformId)) {
            await assertPlatformAuthIsOpenTo({ email, platformId, log })
            const mayJoin = await mayJoinPlatform({ email, platformId, identity: existingIdentity, log })
            if (!mayJoin) {
                return
            }
        }
        if (isNil(existingIdentity)) {
            try {
                await userIdentityService(log).create({
                    email,
                    password: await cryptoUtils.generateRandomPassword(),
                    firstName: signupNames.firstNameFromEmail(email),
                    lastName: '',
                    trackEvents: true,
                    newsLetter: false,
                    provider: UserIdentityProvider.EMAIL,
                    verified: false,
                })
            }
            catch (error) {
                const duplicate = (error instanceof QueryFailedError && error.driverError?.code === '23505') || (error instanceof ActivepiecesError && error.error.code === ErrorCode.EXISTING_USER)
                if (hostingConfiguration.getServiceMode() !== 'hosted' || !duplicate || !await userIdentityService(log).getIdentityByEmail(email)) throw error
            }
        }
        await otpService(log).createAndSend({
            platformId,
            email,
            type: OtpType.EMAIL_LOGIN,
        })
        const identity = await userIdentityService(log).getIdentityByEmail(email)
        if (!isNil(identity)) {
            rejectedPromiseHandler(trackEmailCodeRequested({
                identityId: identity.id,
                platformId,
                isNewIdentity: isNil(existingIdentity),
                log,
            }), log)
        }
    },

    async verifyCode({ email, code, platformId }: VerifyCodeParams): Promise<AuthenticationResult> {
        const identity = await userIdentityService(log).getIdentityByEmail(email)
        if (isNil(identity)) {
            throw new ActivepiecesError({ code: ErrorCode.INVALID_OTP, params: {} })
        }
        if (!isNil(platformId)) {
            await assertPlatformAuthIsOpenTo({ email, platformId, log })
        }
        const codeIsValid = await otpService(log).confirm({
            identityId: identity.id,
            type: OtpType.EMAIL_LOGIN,
            value: code,
        })
        if (!codeIsValid) {
            throw new ActivepiecesError({ code: ErrorCode.INVALID_OTP, params: {} })
        }
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            const verified = await hostingTransactions.run({ dataSource: databaseConnection(), fn: async manager => {
                const current = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identity.id }, lock: { mode: 'pessimistic_write' } })
                if (!current || current.email !== identity.email) throw new ActivepiecesError({ code: ErrorCode.INVALID_OTP, params: {} })
                if (!current.verified) {
                    const changes = { verified: true, password: await passwordHasher.hash(await cryptoUtils.generateRandomPassword()), tokenVersion: apId() }
                    await manager.getRepository(UserIdentityEntity).update({ id: current.id }, changes)
                    return { ...current, ...changes }
                }
                return current
            } })
            const selected = await authenticationService(log).selectCloudSignInPlatformId({ identityId: verified.id })
            if (selected) {
                await assertPlatformAuthIsOpenTo({ email: verified.email, platformId: selected, log })
                return { response: await authenticationService(log).switchPlatform({ identityId: verified.id, platformId: selected, tokenVersion: verified.tokenVersion ?? null }), signedUp: false }
            }
            return authenticationUtils(log).provisionOrOnboard({ identityId: verified.id, expectedTokenVersion: verified.tokenVersion ?? null })
        }
        const verifiedIdentity = identity.verified ? identity : await userIdentityService(log).verifyAndDiscardPassword(identity.id)
        await flagService(log).save({ id: ApFlagId.USER_CREATED, value: true })

        const preferredPlatformId = isNil(platformId)
            ? await authenticationService(log).selectCloudSignInPlatformId({ identityId: verifiedIdentity.id })
            : platformId
        rejectedPromiseHandler(trackForIdentity({
            identityId: verifiedIdentity.id,
            platformId: preferredPlatformId,
            event: {
                name: TelemetryEventName.EMAIL_CODE_VERIFIED,
                payload: { needsNameStep: isNil(preferredPlatformId) },
            },
            log,
        }), log)

        if (!isNil(platformId)) {
            const mayJoin = await mayJoinPlatform({ email, platformId, identity: verifiedIdentity, log })
            if (!mayJoin) {
                throw new ActivepiecesError({
                    code: ErrorCode.INVITATION_ONLY_SIGN_UP,
                    params: { message: 'User is not invited to the platform' },
                })
            }
            const { user, created } = await userService(log).getOrCreateWithProject({
                identity: verifiedIdentity,
                platformId,
            })
            rejectedPromiseHandler(telemetry(log).aliasIdentity({ identityId: verifiedIdentity.id, userId: user.id, platformId }), log)
            await userInvitationsService(log).provisionUserInvitation({ email })
            const response = await authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId,
                projectId: null,
            })
            return { response, signedUp: created }
        }

        if (!isNil(preferredPlatformId)) {
            await assertPlatformAuthIsOpenTo({ email, platformId: preferredPlatformId, log })
            const { user, created } = await userService(log).getOrCreateWithProject({
                identity: verifiedIdentity,
                platformId: preferredPlatformId,
            })
            rejectedPromiseHandler(telemetry(log).aliasIdentity({ identityId: verifiedIdentity.id, userId: user.id, platformId: preferredPlatformId }), log)
            const response = await authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId: preferredPlatformId,
                projectId: null,
            })
            return { response, signedUp: created }
        }
        return authenticationUtils(log).provisionOrOnboard({ identityId: verifiedIdentity.id })
    },

    async completeSignUp({ identityId, fullName, tokenVersion }: CompleteSignUpParams): Promise<AuthenticationResult & { provider: UserIdentityProvider }> {
        const identity = await userIdentityService(log).getOneOrFail({ id: identityId })
        const { firstName, lastName } = signupNames.splitFullName({ fullName, email: identity.email })
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            const tenant = await (await hostingServices.onboarding()).provision({ identityId, name: signupNames.platformNameFromSignup({ firstName, email: identity.email }), names: { firstName, lastName }, expectedTokenVersion: tokenVersion })
            return { response: await authenticationUtils(log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion }), signedUp: tenant.created, provider: identity.provider }
        }
        const writeNames = async (): Promise<void> => {
            await userIdentityService(log).updateNames({ id: identityId, firstName, lastName })
        }
        const { response, provisioned } = await platformService(log).createPlatformWithProject({
            identityId,
            name: signupNames.platformNameFromSignup({ firstName, email: identity.email }),
            invalidatePreviousTokens: false,
            isFirstPlatform: true,
            callerTokenVersion: undefined,
            beforeProvision: writeNames,
        })
        return { response, signedUp: provisioned, provider: identity.provider }
    },
})

async function trackEmailCodeRequested({ identityId, platformId, isNewIdentity, log }: TrackEmailCodeRequestedParams): Promise<void> {
    const preferredPlatformId = isNil(platformId)
        ? await authenticationService(log).selectCloudSignInPlatformId({ identityId })
        : platformId
    await trackForIdentity({
        identityId,
        platformId: preferredPlatformId,
        event: {
            name: TelemetryEventName.EMAIL_CODE_REQUESTED,
            payload: { isNewIdentity },
        },
        log,
    })
}

async function trackForIdentity({ identityId, platformId, event, log }: TrackForIdentityParams): Promise<void> {
    const user = isNil(platformId) ? null : await userService(log).getOneByIdentityAndPlatform({ identityId, platformId })
    if (!isNil(user) && !isNil(platformId)) {
        await telemetry(log).trackUser({ userId: user.id, platformId, event })
        return
    }
    await telemetry(log).trackIdentity({ identityId, platformId, event })
}

async function assertPlatformAuthIsOpenTo({ email, platformId, log }: PlatformGateParams): Promise<void> {
    await authenticationUtils(log).assertEmailAuthIsEnabled({
        platformId,
        provider: UserIdentityProvider.EMAIL,
    })
    await authenticationUtils(log).assertDomainIsAllowed({ email, platformId })
}

async function mayJoinPlatform({ email, platformId, identity, log }: MayJoinPlatformParams): Promise<boolean> {
    if (system.get(AppSystemProp.ALLOW_OPEN_SIGN_UP) === 'true') {
        return true
    }
    const isExistingMember = !isNil(identity)
        && !isNil(await userService(log).getOneByIdentityAndPlatform({ identityId: identity.id, platformId }))
    if (isExistingMember) {
        return true
    }
    return userInvitationsService(log).hasAnyAcceptedInvitations({ platformId, email })
}

type TrackEmailCodeRequestedParams = {
    identityId: string
    platformId: string | null
    isNewIdentity: boolean
    log: FastifyBaseLogger
}

type TrackForIdentityParams = {
    identityId: string
    platformId: string | null
    event: TelemetryEvent
    log: FastifyBaseLogger
}

type RequestCodeParams = {
    strictCaptcha?: boolean
    email: string
    platformId: string | null
    captchaToken: string | undefined
    remoteIp: string | undefined
}

type CompleteSignUpParams = {
    tokenVersion?: string | null
    identityId: string
    fullName: string
}

type VerifyCodeParams = {
    email: string
    code: string
    platformId: string | null
}

type PlatformGateParams = {
    email: string
    platformId: string
    log: FastifyBaseLogger
}

type MayJoinPlatformParams = PlatformGateParams & {
    identity: UserIdentity | null
}
