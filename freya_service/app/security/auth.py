import hmac

from fastapi import Header, HTTPException

from ..config import Settings


def require_service_auth(settings: Settings, authorization: str | None = Header(default=None)) -> None:
    expected = settings.service_token
    supplied = authorization.removeprefix("Bearer ") if authorization else ""
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")
