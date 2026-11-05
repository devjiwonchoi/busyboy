use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ErrorObject;

/// JSON-RPC request id. The desktop uses integers, but strings are accepted too.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    Text(String),
}

impl std::fmt::Display for RequestId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RequestId::Number(number) => write!(f, "{number}"),
            RequestId::Text(text) => f.write_str(text),
        }
    }
}

fn jsonrpc_version() -> String {
    "2.0".to_owned()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    #[serde(default = "jsonrpc_version")]
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
}

impl Response {
    pub fn ok(id: RequestId, result: Value) -> Self {
        Response { jsonrpc: jsonrpc_version(), id, result: Some(result), error: None }
    }

    pub fn err(id: RequestId, error: ErrorObject) -> Self {
        Response { jsonrpc: jsonrpc_version(), id, result: None, error: Some(error) }
    }
}

/// Unsolicited helper → desktop message (no id).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Notification {
    pub fn new(method: &str, params: Value) -> Self {
        Notification { jsonrpc: jsonrpc_version(), method: method.to_owned(), params }
    }
}

/// Any message one side can receive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Response(Response),
    Notification(Notification),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_requests_responses_and_notifications() {
        let request: Message = serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{}}"#).unwrap();
        assert!(matches!(request, Message::Request(Request { id: RequestId::Number(1), .. })));

        let response: Message = serde_json::from_str(r#"{"jsonrpc":"2.0","id":"a","result":{}}"#).unwrap();
        assert!(matches!(response, Message::Response(_)));

        let notification: Message =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"lock_changed","params":{"locked":true}}"#).unwrap();
        assert!(matches!(notification, Message::Notification(_)));
    }
}
