import { devDataSeed } from './dev-seeds'
import { knowledgeBaseSeed } from './knowledge-base-seed'

export const databaseSeeds = {
    async run() {
        const seeds = [
            devDataSeed,
            knowledgeBaseSeed,
        ]
        for (const seed of seeds) {
            await seed.run()
        }
    },
}