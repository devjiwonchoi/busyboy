use std::io::{self, Read, Write};

/// Largest frame body either side accepts (16 MiB).
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// The announced body length is larger than [`MAX_FRAME_BYTES`].
    TooLarge(usize),
    /// The body is not valid UTF-8.
    InvalidUtf8,
    /// The stream ended in the middle of a frame.
    Truncated,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(error) => write!(f, "frame i/o failed: {error}"),
            FrameError::TooLarge(size) => write!(f, "frame of {size} bytes exceeds the limit"),
            FrameError::InvalidUtf8 => f.write_str("frame body is not UTF-8"),
            FrameError::Truncated => f.write_str("stream ended inside a frame"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        FrameError::Io(error)
    }
}

/// Encodes one frame: length prefix plus body.
pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>, FrameError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(body.len()));
    }

    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

/// Writes one frame and flushes.
pub fn write_frame(writer: &mut impl Write, body: &[u8]) -> Result<(), FrameError> {
    let frame = encode_frame(body)?;
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Reads one frame body. Returns `Ok(None)` on a clean end of stream between frames.
pub fn read_frame(reader: &mut impl Read) -> Result<Option<String>, FrameError> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        match reader.read(&mut header[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }

    let length = u32::from_be_bytes(header) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(length));
    }

    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            FrameError::Truncated
        } else {
            FrameError::Io(error)
        }
    })?;
    String::from_utf8(body).map(Some).map_err(|_| FrameError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_frames_in_sequence() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, br#"{"a":1}"#).unwrap();
        write_frame(&mut buffer, "héllo".as_bytes()).unwrap();
        assert_eq!(&buffer[..4], &[0, 0, 0, 7]);

        let mut reader = buffer.as_slice();
        assert_eq!(read_frame(&mut reader).unwrap().as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(read_frame(&mut reader).unwrap().as_deref(), Some("héllo"));
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_oversized_and_broken_frames() {
        let oversized = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
        assert!(matches!(read_frame(&mut oversized.as_slice()), Err(FrameError::TooLarge(_))));

        let truncated = [0u8, 0, 0, 5, b'a'];
        assert!(matches!(read_frame(&mut truncated.as_slice()), Err(FrameError::Truncated)));

        let half_header = [0u8, 0];
        assert!(matches!(read_frame(&mut half_header.as_slice()), Err(FrameError::Truncated)));

        let invalid = [0u8, 0, 0, 1, 0xff];
        assert!(matches!(read_frame(&mut invalid.as_slice()), Err(FrameError::InvalidUtf8)));

        assert!(matches!(encode_frame(&vec![0; MAX_FRAME_BYTES + 1]), Err(FrameError::TooLarge(_))));
    }
}
