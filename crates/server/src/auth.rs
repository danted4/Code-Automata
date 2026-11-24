use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::header::{AUTHORIZATION, HOST};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;
use crate::state::AppState;

/// Refuse any request without the launch token, or addressed to another host name.
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
    let token_ok = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|t| same(t.as_bytes(), state.config.token.as_bytes()));
    if !token_ok {
        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "missing or wrong token",
        )
        .into_response();
    }
    next.run(req).await
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
