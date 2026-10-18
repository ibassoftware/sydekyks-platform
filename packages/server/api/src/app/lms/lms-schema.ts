import { z } from 'zod'

export const lessonSchema = z.object({ id: z.string().regex(/^[a-z0-9-]+$/).max(80), title: z.string().min(1).max(160), body: z.string().min(1).max(30000), exercise: z.string().max(10000), resources: z.array(z.object({ title: z.string().min(1).max(160), url: z.string().max(2000).refine(value => /^https:\/\//.test(value) && z.url().safeParse(value).success || /^\/learning\/templates\/[a-z0-9-]+\.json$/.test(value), 'Use HTTPS or a packaged learning template URL') })).max(12) }).strict()
export const questionSchema = z.object({ id: z.string().min(1).max(80), prompt: z.string().min(1).max(2000), options: z.array(z.string().min(1).max(1000)).length(4), correctIndex: z.number().int().min(0).max(3) }).strict()
export const courseContentSchema = z.object({ title: z.string().min(1).max(160), description: z.string().min(1).max(2000), lessons: z.array(lessonSchema).min(1).max(60), questions: z.array(questionSchema).max(200) }).strict().superRefine((value, ctx) => {
    for (const key of ['lessons', 'questions'] as const) if (new Set(value[key].map(item => item.id)).size !== value[key].length) ctx.addIssue({ code: 'custom', message: `Duplicate ${key} IDs`, path: [key] })
})
export type CourseContent = z.infer<typeof courseContentSchema>
export type Question = z.infer<typeof questionSchema>
export const safetySchema = z.object({ credentials: z.boolean(), isolation: z.boolean(), spending: z.boolean(), recovery: z.boolean(), humanApproval: z.boolean() }).strict()
export type PracticalReview = { submission: Assignment, score: number, safety: z.infer<typeof safetySchema>, feedback: string, assessorIdentityId: string, reviewedAt: string, passed: boolean }
export type Assignment = { submission: string, submittedAt: string }
export type ExamQuestion = Question
