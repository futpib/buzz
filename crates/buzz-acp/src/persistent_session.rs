use std::time::Duration;

use crate::{acp::AcpClient, AcpError};

pub struct PersistentAcpSession {
    client: AcpClient,
    session_id: String,
}

impl PersistentAcpSession {
    pub async fn spawn(
        command: &str,
        args: &[String],
        cwd: &str,
        title: Option<&str>,
    ) -> Result<Self, AcpError> {
        let mut client = AcpClient::spawn(command, args, &[], false).await?;
        client.initialize().await?;
        let session = client.session_new_full(cwd, vec![], None, title).await?;
        Ok(Self {
            client,
            session_id: session.session_id,
        })
    }

    pub async fn prompt(
        &mut self,
        prompt: &str,
        idle_timeout: Duration,
        max_duration: Duration,
    ) -> Result<String, AcpError> {
        let (_, text) = self
            .client
            .session_prompt_capture_with_idle_timeout(
                &self.session_id,
                prompt,
                idle_timeout,
                max_duration,
            )
            .await?;
        Ok(text)
    }

    pub async fn shutdown(&mut self) {
        let _ = self.client.session_close(&self.session_id).await;
        self.client.shutdown().await;
    }
}
