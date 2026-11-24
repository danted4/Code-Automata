use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    ACCESS_CONTROL_MAX_AGE, ACCESS_CONTROL_REQUEST_METHOD, AUTHORIZATION, HOST, ORIGIN, VARY,
};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;
use crate::state::AppState;

/// Refuse any request without the launch token, or addressed to another host name.
///
/// Cross-origin requests are allowed only from the origins in `Config::allowed_origins` (the
/// desktop app's own page). For those, a CORS preflight is answered without the token, since
/// browsers never send credentials with one, and every response carries the CORS headers, so
/// the page can read errors too. Every other request still needs the token. With no allowed
/// origins (`ca-server` behind the Vite proxy) no CORS header is ever sent.
pub async fn check(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let port = state.config.port;
    let host_ok = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
    if !host_ok {
        return ApiError::new(StatusCode::FORBIDDEN, "bad_host", "unexpected Host header")
            .into_response();
    }
    let origin = req
        .headers()
        .get(ORIGIN)
        .filter(|o| {
            o.to_str()
                .is_ok_and(|o| state.config.allowed_origins.iter().any(|a| a == o))
        })
        .cloned();
    let preflight = req.method() == Method::OPTIONS
        && req.headers().contains_key(ACCESS_CONTROL_REQUEST_METHOD);
    if preflight {
        return match origin {
            Some(origin) => {
                let mut res = StatusCode::NO_CONTENT.into_response();
                let h = res.headers_mut();
                h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
                h.insert(
                    ACCESS_CONTROL_ALLOW_METHODS,
                    HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"),
                );
                h.insert(
                    ACCESS_CONTROL_ALLOW_HEADERS,
                    HeaderValue::from_static("authorization, content-type, x-project-path"),
                );
                h.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
                h.insert(VARY, HeaderValue::from_static("origin"));
                res
            }
            None => ApiError::new(StatusCode::FORBIDDEN, "bad_origin", "origin not allowed")
                .into_response(),
        };
    }
    let token_ok = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|t| same(t.as_bytes(), state.config.token.as_bytes()));
    let mut res = if token_ok {
        next.run(req).await
    } else {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong token",
        )
        .into_response()
    };
    if let Some(origin) = origin {
        res.headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        res.headers_mut()
            .insert(VARY, HeaderValue::from_static("origin"));
    }
    res
}

/// Compare without stopping at the first difference, so timing says nothing about the token.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    #[test]
    fn same_compares_whole_tokens() {
        assert!(super::same(b"abc", b"abc"));
        assert!(!super::same(b"abc", b"abd"));
        assert!(!super::same(b"abc", b"abcd"));
        assert!(!super::same(b"", b"a"));
    }
}
