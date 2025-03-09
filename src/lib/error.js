class HTTPStatusError extends Error {
    constructor(code) {
        code = parseInt(code);
        super(`HTTP Status ${code}`);
        this.name = 'HTTPStatusError';
        this.code = code;
    }
}

export default HTTPStatusError;
export { HTTPStatusError };
