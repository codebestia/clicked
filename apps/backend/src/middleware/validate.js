export function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            res.status(400).json({
                error: 'Validation failed',
                issues: result.error.issues.map((i) => ({
                    field: i.path.join('.') || 'unknown',
                    message: i.message,
                })),
            });
            return;
        }
        req.body = result.data;
        next();
    };
}
//# sourceMappingURL=validate.js.map