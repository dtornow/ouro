;;; boot.el --- One request, one round of eval; Claude writes the loop -*- lexical-binding: t -*-

(require 'url)
(defvar url-http-end-of-headers)

(defvar this-file
  (with-temp-buffer (insert-file-contents load-file-name) (buffer-string))
  "The contents of this file.")

(defvar agent-boot-prompt
  "You are running inside GNU Emacs. Your only tool, eval, evaluates Emacs \
Lisp in this Emacs. This is your harness:

%s

This call is a bootstrap: `agent' makes one request, runs your evals once \
for side effects, and drops their results. You will not see any eval result \
in this call, so do not explore. In a single eval, redefine `agent' so that \
it sends tool_result blocks back through `agent-prompt' and loops until you \
reply without calling a tool. Then call your new `agent' with the user's task:

%s")

(defun agent-prompt (messages)
  "Send MESSAGES (a vector) to Claude and return the response content."
  (let* ((url-request-method "POST")
         (url-request-extra-headers
          `(("x-api-key" . ,(encode-coding-string (getenv "ANTHROPIC_API_KEY") 'utf-8))
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
             :messages ,messages)))
         (response (with-current-buffer
                       (url-retrieve-synchronously "https://api.anthropic.com/v1/messages" t)
                     (goto-char url-http-end-of-headers)
                     (json-parse-buffer :object-type 'alist))))
    (or (alist-get 'content response)
        (error "%s" (alist-get 'message (alist-get 'error response))))))

(defun agent-eval (expression)
  "Eval EXPRESSION (a string) and return the printed result or error."
  (condition-case err
      (prin1-to-string (eval (read expression) t))
    (error (error-message-string err))))

(defun agent (prompt)
  "Send PROMPT; run any eval Claude asks for once."
  (mapconcat
   (lambda (block)
     (if (equal (alist-get 'type block) "tool_use")
         (agent-eval (alist-get 'expression (alist-get 'input block)))
       (or (alist-get 'text block) "")))
   (agent-prompt `[(:role "user" :content ,prompt)])
   ""))

(defun agent-boot (task)
  (agent (format agent-boot-prompt this-file task)))

;;; boot.el ends here
