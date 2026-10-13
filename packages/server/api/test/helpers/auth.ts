import { Principal } from '@activepieces/shared'
import jwt, { Algorithm, JwtPayload, SignOptions } from 'jsonwebtoken'

const generateToken = ({
    payload,
    algorithm = 'HS256',
    key = process.env.AP_JWT_SECRET ?? 'secret',
    keyId = '1',
    issuer = 'activepieces',
}: GenerateTokenParams): string => {
    const options: SignOptions = {
        algorithm,
        expiresIn: '1h',
        keyid: keyId,
        issuer,
    }

    return jwt.sign(payload, key, options)
}

export const generateMockToken = async (
    principal: Principal,
): Promise<string> => {
    const mockPrincipal: Principal = principal

    return generateToken({
        payload: mockPrincipal,
        issuer: 'activepieces',
    })
}

export const decodeToken = (token: string): JwtPayload | null => {
    return jwt.decode(token, { json: true })
}

type GenerateTokenParams = {
    payload: Record<string, unknown>
    algorithm?: Algorithm
    key?: string
    keyId?: string
    issuer?: string
}

