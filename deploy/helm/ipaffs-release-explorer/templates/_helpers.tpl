{{- define "explorer.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "explorer.selectorLabels" -}}
app.kubernetes.io/name: ipaffs-release-explorer
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "explorer.labels" -}}
{{ include "explorer.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}
