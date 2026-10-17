import { ActivepiecesError, apId, assertNotNullOrUndefined, ErrorCode, isNil } from '@activepieces/core-utils'
import { cryptoUtils } from '@activepieces/server-utils'
import { ApEdition, ApEnvironment, ApFlagId, AuthenticationResponse, OtpType, PlatformWithoutSensitiveData, User, UserIdentity, UserIdentityProvider } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { databaseConnection } from '../database/database-connection'
import { flagService } from '../flags/flag.service'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { hostingServices } from '../hosting/hosting-services'
import { hostingTransactions } from '../hosting/hosting-transactions'
import { platformService } from '../platform/platform.service'
import { userService } from '../user/user-service'
import { userInvitationsService } from '../user-invitations/user-invitation.service'
import { AuthenticationResult, authenticationUtils } from './authentication-utils'
import { passwordHasher } from './lib/password-hasher'
import { zerobounce } from './lib/zerobounce'
import { otpService } from './otp/otp-service'
import { UserIdentityEntity } from './user-identity/user-identity-entity'
import { userIdentityService } from './user-identity/user-identity-service'

const PLATFORM_CONTROLLED_PROVIDERS = new Set([UserIdentityProvider.JWT, UserIdentityProvider.SAML])

export const authenticationService = (log: FastifyBaseLogger) => ({
    async verifyHostedEmail({ email, code, newPassword }: { email: string, code: string, newPassword: string }): Promise<AuthenticationResult> {
        if (hostingConfiguration.getServiceMode() !== 'hosted') throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
        const identity = await userIdentityService(log).getIdentityByEmail(email)
        if (!identity || identity.verified || !await otpService(log).confirm({ identityId: identity.id, type: OtpType.EMAIL_VERIFICATION, value: code })) throw new ActivepiecesError({ code: ErrorCode.INVALID_OTP, params: {} })
        const password = await passwordHasher.hash(newPassword)
        const tokenVersion = await hostingTransactions.run({ dataSource: databaseConnection(), fn: async manager => {
            const current = await manager.getRepository(UserIdentityEntity).findOne({ where: { id: identity.id }, lock: { mode: 'pessimistic_write' } })
            if (!current || current.verified || current.email !== identity.email) throw new ActivepiecesError({ code: ErrorCode.INVALID_OTP, params: {} })
            const nextVersion = apId()
            await manager.getRepository(UserIdentityEntity).update({ id: current.id }, { verified: true, password, tokenVersion: nextVersion })
            return nextVersion
        } })
        return authenticationUtils(log).provisionOrOnboard({ identityId: identity.id, expectedTokenVersion: tokenVersion })
    },
    async signUp(params: SignUpParams): Promise<AuthenticationResult> {
        if (requiresSignUpAbuseCheck(params.provider)) {
            const maySignUp = await zerobounce.maySignUp({ email: params.email, log })
            if (!maySignUp) {
                throw refusedSignUpError(params)
            }
        }
        const hosted = hostingConfiguration.getServiceMode() === 'hosted'
        if (hosted && params.platformId) throw new ActivepiecesError({ code: ErrorCode.AUTHORIZATION, params: {} })
        const platformId = params.platformId

        if (!isNil(platformId)) {
            await authenticationUtils(log).assertEmailAuthIsEnabled({
                platformId,
                provider: params.provider,
            })
            await authenticationUtils(log).assertDomainIsAllowed({
                email: params.email,
                platformId,
            })
            if (system.get(AppSystemProp.ALLOW_OPEN_SIGN_UP) !== 'true') {
                await authenticationUtils(log).assertUserIsInvitedToPlatformOrProject({
                    email: params.email,
                    platformId,
                })
            }
            const userIdentity = await userIdentityService(log).create({
                ...params,
                verified: true,
            })
            const { user } = await userService(log).getOrCreateWithProject({
                identity: userIdentity,
                platformId,
            })
            if (!hosted) await userInvitationsService(log).provisionUserInvitation({ email: params.email })

            log.info({ email: params.email, platform: { id: platformId } }, 'User signed up to existing platform')
            const response = await authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId,
                projectId: null,
            })
            return { response, signedUp: true }
        }

        const hasInvitations = await userInvitationsService(log).hasAnyAcceptedInvitationsForEmail({ email: params.email })
        const isFederatedProvider = params.provider === UserIdentityProvider.GOOGLE || params.provider === UserIdentityProvider.JWT || params.provider === UserIdentityProvider.SAML
        const userIdentity = await userIdentityService(log).create({
            ...params,
            verified: (!hosted && hasInvitations) || isFederatedProvider,
        })
        await sendVerificationOrAutoVerify(userIdentity, log)
        await flagService(log).save({ id: ApFlagId.USER_CREATED, value: true })
        await authenticationUtils(log).saveNewsLetterSubscriber(userIdentity)
        if (hostingConfiguration.getServiceMode() !== 'hosted') await userInvitationsService(log).provisionUserInvitation({ email: params.email })

        const preferredPlatformId = await authenticationService(log).selectCloudSignInPlatformId({ identityId: userIdentity.id })
        if (!isNil(preferredPlatformId)) {
            const { user } = await userService(log).getOrCreateWithProject({
                identity: userIdentity,
                platformId: preferredPlatformId,
            })
            log.info({ email: params.email, provider: params.provider, preferredPlatformId }, 'User signed up with invitation, returning preferred platform token')
            const authResponse =  await authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId: preferredPlatformId,
                projectId: null,
            })
            rejectedPromiseHandler(authenticationUtils(log).sendTelemetry({ identity: userIdentity, user, projectId: authResponse.projectId ?? '' }), log)
            return { response: authResponse, signedUp: true }
        }
        log.info({ email: params.email, provider: params.provider }, 'User signed up without a platform to join')
        return authenticationUtils(log).provisionOrOnboard({ identityId: userIdentity.id })

    },
    async signInWithPassword(params: SignInWithPasswordParams): Promise<AuthenticationResult> {
        const identity = await userIdentityService(log).verifyIdentityPassword(params)
        const platformId = isNil(params.predefinedPlatformId) ? await authenticationService(log).selectCloudSignInPlatformId({ identityId: identity.id }) : params.predefinedPlatformId

        if (hostingConfiguration.getServiceMode() === 'hosted') {
            const expectedTokenVersion = identity.tokenVersion ?? null
            if (!platformId) return authenticationUtils(log).provisionOrOnboard({ identityId: identity.id, expectedTokenVersion })
            await authenticationUtils(log).assertEmailAuthIsEnabled({ platformId, provider: UserIdentityProvider.EMAIL })
            await authenticationUtils(log).assertDomainIsAllowed({ email: identity.email, platformId })
            return { response: await authenticationService(log).switchPlatform({ identityId: identity.id, platformId, tokenVersion: expectedTokenVersion }), signedUp: false }
        }
        if (isNil(platformId)) { // always cloud
            // A Cloud password sign-up is created unverified and only gets its
            // platform here, on the first sign-in after the verification email.
            // `signedUp` carries that moment out so the controller can stamp it.
            log.info({ email: params.email }, 'User signed in without an active platform on cloud')
            return authenticationUtils(log).provisionOrOnboard({ identityId: identity.id })
        }

        await authenticationUtils(log).assertEmailAuthIsEnabled({
            platformId,
            provider: UserIdentityProvider.EMAIL,
        })
        await authenticationUtils(log).assertDomainIsAllowed({
            email: params.email,
            platformId,
        })
        const user = await userService(log).getOneByIdentityAndPlatform({
            identityId: identity.id,
            platformId,
        })
        if (isNil(user)) {
            throw new ActivepiecesError({
                code: ErrorCode.USER_NOT_FOUND_ON_PLATFORM,
                params: {
                    email: identity.email,
                },
            })
        }
        log.info({ email: params.email, platform: { id: platformId } }, 'User signed in with password')
        const response = await authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
        })
        return { response, signedUp: false }
    },
    async selectCloudSignInPlatformId({ identityId }: SelectCloudSignInPlatformIdParams): Promise<string | null> {
        if (hostingConfiguration.getServiceMode() !== 'hosted' && system.getEdition() !== ApEdition.CLOUD) {
            return null
        }
        const platforms = await platformService(log).listPlatformsForIdentityWithAtleastProject({ identityId })
        const identity = await userIdentityService(log).getOneOrFail({ id: identityId })
        const lastUsed = !isNil(identity.lastLoggedInPlatformId) ? platforms.find((p) => p.id === identity.lastLoggedInPlatformId) : undefined
        if (hostingConfiguration.getServiceMode() === 'hosted') return lastUsed?.id ?? platforms[0]?.id ?? null
        const licensed = platforms.find((p) => !isNil(p.plan.licenseKey))
        return lastUsed?.id ?? licensed?.id ?? platforms[0]?.id ?? null
    },
    async federatedAuthn(params: FederatedAuthnParams): Promise<AuthenticationResult> {
        const platformId = isNil(params.predefinedPlatformId) ? await selectCloudSignInPlatformIdByEmail({ email: params.email, log }) : params.predefinedPlatformId
        const userIdentity = await userIdentityService(log).getIdentityByEmail(params.email)

        if (isNil(platformId)) { // always cloud
            if (!isNil(userIdentity)) {
                return authenticationUtils(log).provisionOrOnboard({ identityId: userIdentity.id })
            }
            return authenticationService(log).signUp({
                email: params.email,
                firstName: params.firstName,
                lastName: params.lastName,
                newsLetter: params.newsLetter,
                trackEvents: params.trackEvents,
                provider: params.provider,
                platformId: null,
                password: await cryptoUtils.generateRandomPassword(),
                imageUrl: params.imageUrl,
            })
        }

        if (params.provider == UserIdentityProvider.SAML) {
            await authenticationUtils(log).assertEmailMatchesSsoDomain({
                email: params.email,
                platformId,
            })
        }

        if (isNil(userIdentity)) {
            return authenticationService(log).signUp({
                email: params.email,
                firstName: params.firstName,
                lastName: params.lastName,
                newsLetter: params.newsLetter,
                trackEvents: params.trackEvents,
                provider: params.provider,
                platformId,
                password: await cryptoUtils.generateRandomPassword(),
                imageUrl: params.imageUrl,
            })
        }
        if (hostingConfiguration.getServiceMode() === 'hosted') return { response: await authenticationService(log).switchPlatform({ identityId: userIdentity.id, platformId }), signedUp: false }
        const { user, created } = await userService(log).getOrCreateWithProject({
            identity: userIdentity,
            platformId,
        })
        await userInvitationsService(log).provisionUserInvitation({ email: params.email })
        const response = await authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
        })
        return { response, signedUp: created }
    },
    async switchPlatform(params: SwitchPlatformParams): Promise<AuthenticationResponse> {
        if (hostingConfiguration.getServiceMode() === 'hosted') {
            const tenant = await (await hostingServices.onboarding()).selectTenant({ actor: { identityId: params.identityId, platformId: params.platformId, ...(params.tokenVersion !== undefined ? { tokenVersion: params.tokenVersion } : {}) } })
            return authenticationUtils(log).getProjectAndToken({ ...tenant, expectedTokenVersion: tenant.tokenVersion })
        }
        const platforms = await platformService(log).listPlatformsForIdentityWithAtleastProject({ identityId: params.identityId })
        const platform = platforms.find((platform) => platform.id === params.platformId)
        await assertUserCanSwitchToPlatform(platform)

        assertNotNullOrUndefined(platform, 'Platform not found')
        const user = await getUserForPlatform(params.identityId, platform, log)
        log.info({ user: { id: user.id }, platform: { id: platform.id } }, 'User switched platform')
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId: platform.id,
            projectId: null,
        })
    },
})

async function assertUserCanSwitchToPlatform(platform: PlatformWithoutSensitiveData | undefined): Promise<void> {
    if (isNil(platform)) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'The user is not a member of the platform',
            },
        })
    }
}

async function getUserForPlatform(identityId: string, platform: PlatformWithoutSensitiveData, log: FastifyBaseLogger): Promise<User> {
    const user = await userService(log).getOneByIdentityAndPlatform({
        identityId,
        platformId: platform.id,
    })
    if (isNil(user)) {
        throw new ActivepiecesError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not member of the platform',
            },
        })
    }
    return user
}

async function sendVerificationOrAutoVerify(userIdentity: UserIdentity, log: FastifyBaseLogger): Promise<void> {
    if (hostingConfiguration.getServiceMode() === 'hosted') {
        if (!userIdentity.verified) await otpService(log).createAndSend({ platformId: null, email: userIdentity.email, type: OtpType.EMAIL_VERIFICATION })
        return
    }
    const edition = system.getEdition()
    const environment = system.get(AppSystemProp.ENVIRONMENT)
    switch (edition) {
        case ApEdition.CLOUD:
            if (environment === ApEnvironment.DEVELOPMENT) {
                await userIdentityService(log).verify(userIdentity.id)
                break
            }
            if (!userIdentity.verified) {
                await otpService(log).createAndSend({
                    platformId: null,
                    email: userIdentity.email,
                    type: OtpType.EMAIL_VERIFICATION,
                })
            }
            break
        case ApEdition.COMMUNITY:
        case ApEdition.ENTERPRISE:
            await userIdentityService(log).verify(userIdentity.id)
            break
    }
}

async function selectCloudSignInPlatformIdByEmail({ email, log }: SelectCloudSignInPlatformIdByEmailParams): Promise<string | null> {
    const identity = await userIdentityService(log).getIdentityByEmail(email)
    if (isNil(identity)) {
        return null
    }
    return authenticationService(log).selectCloudSignInPlatformId({ identityId: identity.id })
}



function requiresSignUpAbuseCheck(provider: UserIdentityProvider): boolean {
    return !PLATFORM_CONTROLLED_PROVIDERS.has(provider)
}

function refusedSignUpError({ email, provider }: SignUpParams): ActivepiecesError {
    const normalizedEmail = email.toLowerCase().trim()
    if (provider === UserIdentityProvider.EMAIL) {
        return new ActivepiecesError({
            code: ErrorCode.EMAIL_IS_NOT_VERIFIED,
            params: { email: normalizedEmail },
        })
    }
    return new ActivepiecesError({
        code: ErrorCode.INVALID_CREDENTIALS,
        params: null,
    })
}

type SelectCloudSignInPlatformIdParams = {
    identityId: string
}

type SelectCloudSignInPlatformIdByEmailParams = {
    email: string
    log: FastifyBaseLogger
}

type FederatedAuthnParams = {
    email: string
    firstName: string
    lastName: string
    newsLetter: boolean
    trackEvents: boolean
    provider: UserIdentityProvider
    predefinedPlatformId: string | null
    imageUrl?: string
}

type SignUpParams = {
    email: string
    firstName: string
    lastName: string
    password: string
    platformId: string | null
    trackEvents: boolean
    newsLetter: boolean
    provider: UserIdentityProvider
    imageUrl?: string
}

type SignInWithPasswordParams = {
    email: string
    password: string
    predefinedPlatformId: string | null
}

type SwitchPlatformParams = {
    tokenVersion?: string | null
    identityId: string
    platformId: string
}
