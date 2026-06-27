export interface JwtPayload {
    userId: string;
    walletAddress: string;
    /** Every token must carry a deviceId.  Legacy tokens without it are rejected. */
    deviceId: string;
}
export declare function signToken(payload: JwtPayload): string;
export declare function verifyToken(token: string): JwtPayload;
//# sourceMappingURL=jwt.d.ts.map