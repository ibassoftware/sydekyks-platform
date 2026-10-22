import { apId } from '@activepieces/core-utils'
import { UserStatus } from '@activepieces/shared'
import { EntityManager, IsNull } from 'typeorm'
import { isOperationalUser } from '../hosting/hosting-access-policy'
import { hostingConfiguration } from '../hosting/hosting-configuration'
import { HostingAccountEntity } from '../hosting/hosting-entities'
import { UserEntity } from '../user/user-entity'
import { LmsCourseEntity, LmsEnrollmentEntity } from './lms-entities'

/** Call inside the activation/admission transaction. Existing/revoked access is never reset. */
export async function enrollClientDefaultCourses(manager: EntityManager, input: { platformId: string, identityId?: string, enrolledBy: string, now?: Date }): Promise<void> {
    if (hostingConfiguration.getServiceMode() !== 'hosted') return
    const account = await manager.getRepository(HostingAccountEntity).findOneBy({ id: input.platformId })
    if (!account || !['starter', 'team', 'scale'].includes(account.planId) || account.status !== 'active') return
    const now = input.now ?? new Date((await manager.query('SELECT clock_timestamp() AS now'))[0].now)
    const users = await manager.getRepository(UserEntity).findBy({ platformId: input.platformId, status: UserStatus.ACTIVE, ...(input.identityId ? { identityId: input.identityId } : {}) })
    const courses = await manager.getRepository(LmsCourseEntity).findBy({ clientDefault: true, ownerPlatformId: IsNull(), audience: 'end_user', certificationMode: 'none', status: 'published' })
    for (const user of users.filter(user => !isOperationalUser(user))) for (const course of courses) {
        // Partial unique index makes concurrent activation/admission retries idempotent.
        await manager.getRepository(LmsEnrollmentEntity).createQueryBuilder().insert().values({ id: apId(), identityId: user.identityId, courseId: course.id, grantPlatformId: input.platformId, accessType: 'learning', package: null, paymentReference: null, workspacePlatformId: null, startsAt: now, accessUntil: new Date(now.getTime() + 365 * 86400000), assessmentUntil: new Date(now.getTime() + 365 * 86400000), status: 'active', completedLessons: [], assignment: null, practicalReviews: [], enrolledBy: input.enrolledBy }).orIgnore().execute()
    }
}
