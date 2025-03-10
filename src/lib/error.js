class HTTPStatusError extends Error {
    constructor(code) {
        code = parseInt(code || 0);
        super(`HTTP Status ${code}`);
        this.name = 'HTTPStatusError';
        this.code = code;
    }
}

export default HTTPStatusError;
export { HTTPStatusError };
