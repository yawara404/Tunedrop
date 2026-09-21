"""Shared JWT secret. Never use a built-in signing key."""
import os
import secrets
import sys
from pathlib import Path
from dotenv import load_dotenv


def load_environment():
    """Read project .env without overriding process variables or executing shell code."""
    path = os.environ.get("TUNEDROP_ENV_FILE") or Path(__file__).with_name(".env")
    load_dotenv(dotenv_path=path, override=False, interpolate=False)


def load_secret():
    load_environment()
    secret = os.environ.get('SECRET_KEY', '').strip()
    if not secret:
        path = Path(os.environ.get('TUNEDROP_SECRET_FILE', str(Path(__file__).with_name('.jwt_secret'))))
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w') as stream:
                stream.write(secrets.token_hex(32) + '\n')
        secret = path.read_text().strip()
    if len(secret) < 32 or secret == 'tunedrop-secret-jwt-key-2026-secure':
        raise RuntimeError('SECRET_KEY must be a new random secret of at least 32 characters')
    return secret


if __name__ == "__main__":
    # Pass the same configuration to the standalone PHP child process.
    load_environment()
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python runtime_config.py COMMAND [ARGS...]")
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
