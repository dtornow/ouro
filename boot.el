;;; boot.el --- One request, one round of eval; Claude writes the loop -*- lexical-binding: t -*-

(require 'url)
(defvar url-http-end-of-headers)

(defvar agent-boot-prompt
  "You are running inside GNU Emacs. Your only tool, eval, evaluates   \
Emacs Lisp in this Emacs. This is your harness, loaded from %s:

%s

This call is a bootstrap: `agent-prompt' makes one request, runs your  \
evals once for side effects, and drops their results. You will not see \
any eval result in this call, so do not explore. In a single eval,     \
redefine `agent-prompt' so that it makes its own requests, sends       \
tool_result blocks back, and loops until you reply without calling a   \
tool. Then call your new `agent-prompt' with the user's task:

%s")

(defun agent-eval (expression)
  "Eval EXPRESSION (a string) and return the printed result or error."
  (if (not (stringp expression))
      "eval error: expression must be a string"
    (condition-case err
        (prin1-to-string (eval (read expression) t))
      (error (error-message-string err)))))

(defun agent-prompt (prompt)
  "Send PROMPT; run any eval Claude asks for once."
  (let* ((api-key (getenv "ANTHROPIC_API_KEY"))
         (_ (unless (and api-key (not (string-empty-p api-key)))
              (error "ANTHROPIC_API_KEY is not set")))
         (url-request-method "POST")
         (url-request-extra-headers
          `(("x-api-key" . ,(encode-coding-string api-key 'utf-8))
            ("anthropic-version" . "2023-06-01")
            ("content-type" . "application/json")))
         (url-request-data
          (json-serialize
           `(:model "claude-sonnet-5-5" :max_tokens 8192
             :tools [(:name "eval"
                      :description "Evaluate one Emacs Lisp expression."
                      :input_schema (:type "object"
                                     :properties (:expression (:type "string"))
                                     :required ["expression"]))]
             :messages [(:role "user" :content ,prompt)])))
         (buffer (or (url-retrieve-synchronously
                      "https://api.anthropic.com/v1/messages" t)
                     (error "Anthropic request failed (no response)")))
         (response (with-current-buffer buffer
                     (goto-char url-http-end-of-headers)
                     (json-parse-buffer :object-type 'alist)))
         (content (or (alist-get 'content response)
                      (error "%s" (or (alist-get 'message (alist-get 'error response))
                                      "Anthropic request failed")))))
    (mapconcat
     (lambda (block)
       (if (equal (alist-get 'type block) "tool_use")
           (agent-eval (alist-get 'expression (alist-get 'input block)))
         (or (alist-get 'text block) "")))
     content "")))

(defun agent-boot (task)
  (let ((file (or (symbol-file 'agent-boot)
                  (error "Cannot locate boot.el (symbol-file is nil)"))))
    (agent-prompt (format agent-boot-prompt file
                          (with-temp-buffer (insert-file-contents file) (buffer-string))
                          task))))

;;; boot.el ends here
