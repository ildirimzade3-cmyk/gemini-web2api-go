package app

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"

	fhttp "github.com/bogdanfinn/fhttp"
)

// Attachments: images, video and arbitrary files sent inline by the client are
// uploaded to Google's storage and referenced in the conversation.
//
// Signed-in accounts only: anonymous uploads succeed but referencing them in a
// conversation is rejected with 1100. The attachment kind is the type slot of
// the file tuple (see gemini.go): 1 = image, 2 = video, 3 = any other file
// (text, PDF, audio, office documents) with its real mime. Kinds 1 and 2 are
// proven (browser captures); that Google's web app reads PDF/audio/office files
// under kind 3 with their real mime is to be verified live, it cannot be tested
// offline.

// Per-kind size caps, checked after decoding. The caps keep one request from
// dragging on; oversized input is rejected (413) instead of uploaded and refused.
const (
	maxImageBytes = 12 * 1024 * 1024
	maxVideoBytes = 50 * 1024 * 1024
	maxFileBytes  = 50 * 1024 * 1024
)

// pendingUpload is an attachment that is not uploaded yet: the upload waits
// until the account and egress are picked (see streamGenerateWithFiles).
type pendingUpload struct {
	Data []byte
	Name string
	Mime string
	Kind int // 1 = image, 2 = video, 3 = other file
}

// clientError is a request the bridge refuses before reaching Google. Status is
// 400 for unsupported input and 413 for oversized input.
type clientError struct {
	Status int
	Code   string
	Msg    string
}

func (e *clientError) Error() string { return e.Msg }

func errUnsupportedInput(format string, args ...interface{}) *clientError {
	return &clientError{Status: http.StatusBadRequest, Code: "unsupported_input", Msg: fmt.Sprintf(format, args...)}
}

func errAttachmentTooLarge(format string, args ...interface{}) *clientError {
	return &clientError{Status: http.StatusRequestEntityTooLarge, Code: "attachment_too_large", Msg: fmt.Sprintf(format, args...)}
}

// Content part types that carry an attachment. The two gemini_* types are what
// the /v1beta handlers turn inlineData / fileData into.
const (
	partGeminiInline = "gemini_inline_data"
	partGeminiFile   = "gemini_file_data"
)

func isAttachmentPart(partType string) bool {
	switch partType {
	case "image_url", "input_image", "video_url", "input_video",
		"file", "input_file", "input_audio", partGeminiInline, partGeminiFile:
		return true
	}
	return false
}

// attachmentSource is one attachment part, before decoding.
type attachmentSource struct {
	Ref      string // data: URL or http(s) link
	B64      string // bare base64 (needs Mime or a filename extension)
	Mime     string // mime hint
	Filename string
	// Legacy is set for the image/video part types: a remote body that is neither
	// image nor video is taken as an image, as before.
	Legacy bool
}

// collectAttachments pulls every attachment out of OpenAI-style messages.
//
// Recognised parts: image_url / input_image / video_url / input_video,
// file {file_data, filename} / input_file {file_data|file_url, filename},
// input_audio {data, format} and the /v1beta inlineData / fileData parts.
// Sources are data: URLs, bare base64, or http(s) links (downloaded here: the
// upstream only accepts attachments from its own storage).
func collectAttachments(messages []map[string]interface{}, proxyURL string) ([]pendingUpload, error) {
	var out []pendingUpload
	for _, m := range messages {
		parts, ok := m["content"].([]interface{})
		if !ok {
			continue
		}
		for _, c := range parts {
			cm, ok := c.(map[string]interface{})
			if !ok {
				continue
			}
			src, found, err := attachmentSourceOf(cm)
			if err != nil {
				return nil, err
			}
			if !found {
				continue
			}
			up, err := materializeAttachment(src, proxyURL, len(out)+1)
			if err != nil {
				return nil, err
			}
			out = append(out, up)
		}
	}
	return out, nil
}

// attachmentSourceOf reads the source of one content part. found is false for
// parts that are not attachments (or are empty).
func attachmentSourceOf(cm map[string]interface{}) (src attachmentSource, found bool, err error) {
	switch getStr(cm, "type") {
	case "image_url":
		if iu, ok := cm["image_url"].(map[string]interface{}); ok {
			src.Ref = getStr(iu, "url")
		} else {
			src.Ref = getStr(cm, "image_url")
		}
		src.Legacy = true
	case "input_image":
		src.Ref = firstNonEmpty(getStr(cm, "image_url"), getStr(cm, "url"), getStr(cm, "data"))
		src.Legacy = true
	case "video_url":
		if vu, ok := cm["video_url"].(map[string]interface{}); ok {
			src.Ref = getStr(vu, "url")
		} else {
			src.Ref = getStr(cm, "video_url")
		}
		src.Legacy = true
	case "input_video":
		src.Ref = firstNonEmpty(getStr(cm, "video_url"), getStr(cm, "url"), getStr(cm, "data"))
		src.Legacy = true
	case "file", "input_file":
		f := cm
		if inner, ok := cm["file"].(map[string]interface{}); ok {
			f = inner
		}
		if id := getStr(f, "file_id"); id != "" && getStr(f, "file_data") == "" && getStr(f, "file_url") == "" {
			return src, false, errUnsupportedInput("file_id is not supported: this API has no file store, send the file inline (file_data) or as file_url")
		}
		src.Filename = getStr(f, "filename")
		data := firstNonEmpty(getStr(f, "file_data"), getStr(f, "file_url"))
		if strings.HasPrefix(data, "data:") || strings.HasPrefix(data, "http://") || strings.HasPrefix(data, "https://") {
			src.Ref = data
		} else {
			src.B64 = data
		}
	case "input_audio":
		a := cm
		if inner, ok := cm["input_audio"].(map[string]interface{}); ok {
			a = inner
		}
		src.B64 = getStr(a, "data")
		src.Mime = audioMime(getStr(a, "format"))
		if src.Mime == "" {
			return src, false, errUnsupportedInput("input_audio.format is required (for example wav or mp3)")
		}
	case partGeminiInline:
		src.B64 = getStr(cm, "data")
		src.Mime = getStr(cm, "mime_type")
		if src.Mime == "" {
			return src, false, errUnsupportedInput("inlineData.mimeType is required")
		}
	case partGeminiFile:
		uri := getStr(cm, "file_uri")
		if !strings.HasPrefix(uri, "http://") && !strings.HasPrefix(uri, "https://") {
			return src, false, errUnsupportedInput("fileData.fileUri must be an http(s) URL the bridge can fetch; " +
				"Google Files API and gs:// URIs are not available here, send the bytes as inlineData")
		}
		src.Ref = uri
		src.Mime = getStr(cm, "mime_type")
	default:
		return src, false, nil
	}
	if strings.TrimSpace(src.Ref) == "" && strings.TrimSpace(src.B64) == "" {
		return src, false, nil
	}
	return src, true, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// materializeAttachment turns a source into upload-ready bytes.
func materializeAttachment(src attachmentSource, proxyURL string, idx int) (pendingUpload, error) {
	switch {
	case strings.HasPrefix(src.Ref, "data:"):
		data, mime, err := decodeDataURL(src.Ref, idx)
		if err != nil {
			return pendingUpload{}, err
		}
		if mime == "" {
			mime = firstNonEmpty(src.Mime, mimeFromFilename(src.Filename))
		}
		if mime == "" && src.Legacy {
			mime = "image/png"
		}
		return newUpload(data, mime, src.Filename, idx)
	case strings.HasPrefix(src.Ref, "http://") || strings.HasPrefix(src.Ref, "https://"):
		data, ctype, err := fetchRemote(src.Ref, proxyURL, idx)
		if err != nil {
			return pendingUpload{}, err
		}
		mime := ctype
		switch {
		case src.Legacy:
			// image_url / video_url keep the old rule: not image or video -> image.
			if !strings.HasPrefix(mime, "image/") && !strings.HasPrefix(mime, "video/") {
				mime = "image/png"
			}
		case mime == "" || mime == "application/octet-stream":
			mime = firstNonEmpty(src.Mime, mimeFromFilename(src.Filename), mimeFromFilename(urlBaseName(src.Ref)))
		}
		name := firstNonEmpty(src.Filename, urlBaseName(src.Ref))
		if src.Legacy {
			name = ""
		}
		return newUpload(data, mime, name, idx)
	case strings.TrimSpace(src.B64) != "":
		data, err := decodeBase64(src.B64)
		if err != nil {
			return pendingUpload{}, fmt.Errorf("attachment %d: bad base64: %w", idx, err)
		}
		mime := firstNonEmpty(src.Mime, mimeFromFilename(src.Filename))
		return newUpload(data, mime, src.Filename, idx)
	}
	return pendingUpload{}, errUnsupportedInput("attachment %d: unsupported source (want a data: URL, base64 data or an http(s) link)", idx)
}

// decodeBase64 accepts standard and URL-safe alphabets, padded or not, and
// ignores line breaks.
func decodeBase64(s string) ([]byte, error) {
	s = strings.NewReplacer("\r", "", "\n", "", " ", "").Replace(s)
	var firstErr error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		} else if firstErr == nil {
			firstErr = err
		}
	}
	return nil, firstErr
}

// decodeDataURL parses data:<mime>[;base64],<payload>. mime is "" when the URL
// names none.
func decodeDataURL(src string, idx int) ([]byte, string, error) {
	comma := strings.Index(src, ",")
	if comma < 0 {
		return nil, "", fmt.Errorf("attachment %d: malformed data URL", idx)
	}
	meta, payload := src[5:comma], src[comma+1:]
	mime := ""
	if i := strings.Index(meta, ";"); i >= 0 {
		mime = meta[:i]
	} else {
		mime = meta
	}
	var data []byte
	var err error
	if strings.Contains(meta, "base64") {
		data, err = decodeBase64(payload)
	} else {
		var unescaped string
		if unescaped, err = url.PathUnescape(payload); err == nil {
			data = []byte(unescaped)
		}
	}
	if err != nil {
		return nil, "", fmt.Errorf("attachment %d: bad data URL payload: %w", idx, err)
	}
	return data, strings.ToLower(strings.TrimSpace(mime)), nil
}

// fetchRemote downloads a remote attachment through the same egress as the
// request (an image fetched from another IP while the conversation leaves from
// this one only exposes one more egress). The body is read up to the largest
// per-kind cap + 1 byte so newUpload can reject an oversized file.
func fetchRemote(src, proxyURL string, idx int) ([]byte, string, error) {
	limit := int64(maxFileBytes) + 1
	var body []byte
	var ctype string
	if proxyURL != "" {
		req, err := http.NewRequest("GET", src, nil)
		if err != nil {
			return nil, "", err
		}
		applyChromeHeaders(req)
		resp, err := getStdlibClient(proxyURL).Do(req)
		if err != nil {
			return nil, "", fmt.Errorf("attachment %d: fetch failed: %w", idx, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, "", fmt.Errorf("attachment %d: fetch returned HTTP %d", idx, resp.StatusCode)
		}
		ctype = resp.Header.Get("Content-Type")
		body, err = io.ReadAll(io.LimitReader(resp.Body, limit))
		if err != nil {
			return nil, "", err
		}
	} else {
		req, err := fhttp.NewRequest("GET", src, nil)
		if err != nil {
			return nil, "", err
		}
		resp, err := getTLSClient().Do(req)
		if err != nil {
			return nil, "", fmt.Errorf("attachment %d: fetch failed: %w", idx, err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, "", fmt.Errorf("attachment %d: fetch returned HTTP %d", idx, resp.StatusCode)
		}
		ctype = resp.Header.Get("Content-Type")
		body, err = io.ReadAll(io.LimitReader(resp.Body, limit))
		if err != nil {
			return nil, "", err
		}
	}
	if i := strings.Index(ctype, ";"); i >= 0 {
		ctype = ctype[:i]
	}
	return body, strings.ToLower(strings.TrimSpace(ctype)), nil
}

func urlBaseName(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	b := path.Base(u.Path)
	if b == "." || b == "/" {
		return ""
	}
	return b
}

// newUpload decides the kind from the mime type and enforces the per-kind cap:
//
//	image/*  -> kind 1, 12 MB
//	video/*  -> kind 2, 50 MB
//	other supported (text/*, audio/*, PDF, JSON/XML, office, OpenDocument) -> kind 3, 50 MB
//
// The kind slot is what the server uses to parse the attachment, so a wrong
// value makes the model read it as the wrong thing.
func newUpload(data []byte, mime, filename string, idx int) (pendingUpload, error) {
	if len(data) == 0 {
		return pendingUpload{}, errUnsupportedInput("attachment %d: empty", idx)
	}
	mime = strings.ToLower(strings.TrimSpace(mime))
	if i := strings.Index(mime, ";"); i >= 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	if mime == "" {
		return pendingUpload{}, errUnsupportedInput("attachment %d: the file type is unknown, give a mime type "+
			"(data: URL, mimeType) or a filename with an extension", idx)
	}
	switch {
	case strings.HasPrefix(mime, "video/"):
		if len(data) > maxVideoBytes {
			return pendingUpload{}, errAttachmentTooLarge("video %d: %d bytes exceeds the %d-byte limit", idx, len(data), maxVideoBytes)
		}
		return pendingUpload{Data: data, Mime: mime, Kind: 2, Name: attachmentName(filename, "video", idx, mime)}, nil
	case strings.HasPrefix(mime, "image/"):
		if len(data) > maxImageBytes {
			return pendingUpload{}, errAttachmentTooLarge("image %d: %d bytes exceeds the %d-byte limit", idx, len(data), maxImageBytes)
		}
		return pendingUpload{Data: data, Mime: mime, Kind: 1, Name: attachmentName(filename, "image", idx, mime)}, nil
	case supportedFileMime(mime):
		if len(data) > maxFileBytes {
			return pendingUpload{}, errAttachmentTooLarge("file %d: %d bytes exceeds the %d-byte limit", idx, len(data), maxFileBytes)
		}
		return pendingUpload{Data: data, Mime: mime, Kind: 3, Name: attachmentName(filename, "file", idx, mime)}, nil
	}
	return pendingUpload{}, errUnsupportedInput("attachment %d: file type %s is not supported "+
		"(images, video, audio, text, PDF, JSON/XML and office documents are)", idx, mime)
}

// supportedFileMime is the allow list of kind-3 types.
func supportedFileMime(mime string) bool {
	switch {
	case strings.HasPrefix(mime, "text/"), strings.HasPrefix(mime, "audio/"):
		return true
	case strings.HasPrefix(mime, "application/vnd.openxmlformats-officedocument."),
		strings.HasPrefix(mime, "application/vnd.oasis.opendocument."):
		return true
	}
	switch mime {
	case "application/pdf", "application/json", "application/xml", "application/rtf",
		"application/x-ndjson", "application/yaml", "application/x-yaml", "application/javascript",
		"application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint":
		return true
	}
	return false
}

// attachmentName picks the file name shown to the model: the client's name
// (path stripped, extension added when missing) or <kind><idx><ext>.
func attachmentName(filename, kind string, idx int, mime string) string {
	ext := mimeExt(mime)
	name := strings.TrimSpace(filename)
	if name != "" {
		name = path.Base(strings.ReplaceAll(name, "\\", "/"))
		name = strings.NewReplacer("\r", "", "\n", "").Replace(name)
	}
	if name == "" || name == "." || name == "/" {
		return fmt.Sprintf("%s%d%s", kind, idx, ext)
	}
	if path.Ext(name) == "" {
		name += ext
	}
	return name
}

var mimeExts = map[string]string{
	"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
	"image/gif": ".gif", "image/heic": ".heic", "image/heif": ".heif", "image/bmp": ".bmp",
	"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/mpeg": ".mpeg",
	"video/x-msvideo": ".avi", "video/x-matroska": ".mkv",
	"application/pdf": ".pdf", "application/json": ".json", "application/xml": ".xml",
	"application/rtf": ".rtf", "application/x-ndjson": ".ndjson", "application/yaml": ".yaml",
	"application/x-yaml": ".yaml", "application/javascript": ".js",
	"application/msword": ".doc", "application/vnd.ms-excel": ".xls", "application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":   ".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
	"application/vnd.oasis.opendocument.text":                                   ".odt",
	"application/vnd.oasis.opendocument.spreadsheet":                            ".ods",
	"application/vnd.oasis.opendocument.presentation":                           ".odp",
	"text/plain": ".txt", "text/markdown": ".md", "text/csv": ".csv", "text/html": ".html",
	"text/xml": ".xml", "text/css": ".css", "text/javascript": ".js", "text/x-python": ".py",
	"text/tab-separated-values": ".tsv", "text/calendar": ".ics",
	"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
	"audio/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac", "audio/aac": ".aac",
	"audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/webm": ".weba", "audio/aiff": ".aiff",
}

// mimeExt gives a file extension for a mime type. The extension is shown to the
// model, and a wrong one makes it misjudge the file.
func mimeExt(mime string) string {
	if e, ok := mimeExts[mime]; ok {
		return e
	}
	switch {
	case strings.HasPrefix(mime, "video/"):
		return ".mp4"
	case strings.HasPrefix(mime, "image/"):
		return ".png"
	case strings.HasPrefix(mime, "text/"):
		return ".txt"
	case strings.HasPrefix(mime, "audio/"):
		return ".audio"
	}
	return ".bin"
}

// extMimes is the reverse lookup used when the client gave bare base64 plus a
// filename: the type is taken from the extension.
var extMimes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
	".gif": "image/gif", ".heic": "image/heic", ".heif": "image/heif", ".bmp": "image/bmp",
	".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mpeg": "video/mpeg",
	".mpg": "video/mpeg", ".avi": "video/x-msvideo", ".mkv": "video/x-matroska",
	".pdf": "application/pdf", ".json": "application/json", ".xml": "application/xml",
	".rtf": "application/rtf", ".ndjson": "application/x-ndjson", ".yaml": "application/yaml",
	".yml": "application/yaml", ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
	".ppt":  "application/vnd.ms-powerpoint",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".odt":  "application/vnd.oasis.opendocument.text",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	".odp":  "application/vnd.oasis.opendocument.presentation",
	".txt":  "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv",
	".tsv": "text/tab-separated-values", ".html": "text/html", ".htm": "text/html",
	".js": "text/javascript", ".css": "text/css", ".py": "text/x-python", ".ics": "text/calendar",
	".mp3": "audio/mpeg", ".mpga": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
	".opus": "audio/opus", ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4",
	".weba": "audio/webm", ".aiff": "audio/aiff",
}

func mimeFromFilename(name string) string {
	return extMimes[strings.ToLower(path.Ext(strings.TrimSpace(name)))]
}

// audioMime maps the OpenAI input_audio format ("wav", "mp3", ...) to a mime type.
func audioMime(format string) string {
	format = strings.ToLower(strings.TrimSpace(format))
	switch format {
	case "":
		return ""
	case "mp3", "mpeg":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "m4a":
		return "audio/mp4"
	}
	if strings.HasPrefix(format, "audio/") {
		return format
	}
	return "audio/" + format
}

// errorAsClient reports whether err is a clientError.
func errorAsClient(err error) (*clientError, bool) {
	var ce *clientError
	if errors.As(err, &ce) {
		return ce, true
	}
	return nil, false
}
