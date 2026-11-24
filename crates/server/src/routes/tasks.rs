use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use ca_core::engine::Engine;
use ca_core::engine::runlog::{RunLogInfo, RunLogLine};
use ca_core::{Provider, Task, TaskList};
use serde_json::{Map, Value};

use super::types::{
    AnswersRequest, CreateTaskRequest, FeedbackRequest, MoveRequest, PlanRequest,
    PullRequestResponse,
};
use super::{Body, check_provider};
use crate::error::ApiError;
use crate::state::{AppState, Project};

type ApiResult<T> = Result<Json<T>, ApiError>;

/// The task as it is now, for commands whose engine call returns nothing.
async fn current(engine: &Engine, id: &str) -> ApiResult<Task> {
    engine
        .get_task(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("task {id} not found")))
}

pub async fn list(Project(engine): Project) -> ApiResult<TaskList> {
    Ok(Json(engine.list_tasks().await?))
}

pub async fn get(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    current(&engine, &id).await
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Project(engine): Project,
    Body(req): Body<CreateTaskRequest>,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    check_provider(&state, req.agent.provider)?;
    let task = engine
        .create_task(
            &req.title,
            &req.description,
            req.agent,
            req.require_plan_approval,
        )
        .await?;
    if req.start {
        engine.start(&task.id).await?;
    }
    Ok((StatusCode::CREATED, Json(task)))
}

/// Edit title, description, agent or plan approval; any other key is refused.
pub async fn patch(
    State(state): State<Arc<AppState>>,
    Project(engine): Project,
    Path(id): Path<String>,
    Body(patch): Body<Map<String, Value>>,
) -> ApiResult<Task> {
    if let Some(provider) = patch
        .get("agent")
        .and_then(|a| a.get("provider"))
        .and_then(|p| serde_json::from_value::<Provider>(p.clone()).ok())
    {
        check_provider(&state, provider)?;
    }
    Ok(Json(engine.patch_task(&id, &patch).await?))
}

pub async fn delete(
    Project(engine): Project,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if engine.get_task(&id).await?.is_none() {
        return Err(ApiError::not_found(format!("task {id} not found")));
    }
    engine.delete_task(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A user drag: the phase table decides, and agents never start from a move.
pub async fn move_to(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<MoveRequest>,
) -> ApiResult<Task> {
    Ok(Json(engine.move_task(&id, req.to).await?))
}

pub async fn start(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.start(&id).await?;
    current(&engine, &id).await
}

/// Returns once the agent has stopped and the run is recorded as paused.
pub async fn pause(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.pause(&id).await?;
    current(&engine, &id).await
}

pub async fn resume(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.resume(&id).await?;
    current(&engine, &id).await
}

pub async fn answers(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<AnswersRequest>,
) -> ApiResult<Task> {
    engine
        .answer_questions(&id, req.answers.into_iter().collect())
        .await?;
    current(&engine, &id).await
}

pub async fn revise_plan(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<FeedbackRequest>,
) -> ApiResult<Task> {
    engine.revise_plan(&id, &req.feedback).await?;
    current(&engine, &id).await
}

pub async fn edit_plan(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<PlanRequest>,
) -> ApiResult<Task> {
    Ok(Json(engine.edit_plan(&id, &req.plan).await?))
}

pub async fn approve_plan(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Task> {
    engine.approve_plan(&id).await?;
    current(&engine, &id).await
}

pub async fn rework(
    Project(engine): Project,
    Path(id): Path<String>,
    Body(req): Body<FeedbackRequest>,
) -> ApiResult<Task> {
    engine.request_rework(&id, &req.feedback).await?;
    current(&engine, &id).await
}

pub async fn skip_subtask(
    Project(engine): Project,
    Path((id, subtask)): Path<(String, String)>,
) -> ApiResult<Task> {
    Ok(Json(engine.skip_subtask(&id, &subtask).await?))
}

pub async fn pull_request(
    Project(engine): Project,
    Path(id): Path<String>,
) -> ApiResult<PullRequestResponse> {
    let url = engine.create_pull_request(&id).await?;
    Ok(Json(PullRequestResponse { url }))
}

pub async fn runs(Project(engine): Project, Path(id): Path<String>) -> ApiResult<Vec<RunLogInfo>> {
    Ok(Json(engine.run_logs(&id).await?))
}

pub async fn run_events(
    Project(engine): Project,
    Path((id, name)): Path<(String, String)>,
) -> ApiResult<Vec<RunLogLine>> {
    Ok(Json(engine.run_log(&id, &name).await?))
}
