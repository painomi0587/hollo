import { capitalize } from "es-toolkit";
import iso6391 from "iso-639-1";

import { type PostVisibility, THEME_COLORS, type ThemeColor } from "../schema";
import { themeColors } from "../theme/colors";
import {
  CheckboxField,
  Field,
  FieldSection,
  SelectField,
  SubmitButton,
  TextareaField,
  TextField,
} from "./forms";

// UnoCSS safelist for ImageUploadField dynamic states:
// size-24 rounded-full aspect-[3/1] rounded-xl overflow-hidden
// border-brand-500 bg-brand-50 dark:border-brand-500 dark:bg-brand-950
// opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
// UnoCSS safelist for CustomFieldsSection dynamic states:
// hidden

const fieldBase =
  "w-full rounded-md bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm transition-colors placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-neutral-50 read-only:text-neutral-500 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:ring-brand-900 dark:read-only:bg-neutral-900 dark:read-only:text-neutral-400";
const fieldValid = "border border-neutral-300 dark:border-neutral-700";

export interface AccountFormProps {
  method?: "get" | "post" | "dialog";
  action: string;
  readOnly?: {
    username?: boolean;
  };
  values?: {
    username?: string;
    name?: string;
    bio?: string;
    protected?: boolean;
    discoverable?: boolean;
    expandSpoilers?: boolean;
    language?: string;
    visibility?: PostVisibility;
    themeColor?: ThemeColor;
    news?: boolean;
    avatarUrl?: string | null;
    coverUrl?: string | null;
    fields?: Array<{ name: string; value: string }>;
  };
  errors?: {
    username?: string;
    name?: string;
    bio?: string;
    avatar?: string;
    header?: string;
  };
  officialAccount: string;
  host: string;
  submitLabel: string;
}

export function AccountForm(props: AccountFormProps) {
  const existingFields = props.values?.fields ?? [];
  const initialVisible = Math.min(Math.max(existingFields.length + 1, 2), 10);
  return (
    <form
      method={props.method ?? "post"}
      action={props.action}
      encType="multipart/form-data"
      class="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <FieldSection legend="Profile images">
        <div class="grid gap-6 sm:grid-cols-2">
          <ImageUploadField
            id="account-avatar"
            name="avatar"
            label="Avatar"
            variant="avatar"
            currentUrl={props.values?.avatarUrl}
            error={props.errors?.avatar}
          />
          <ImageUploadField
            id="account-header"
            name="header"
            label="Header image"
            variant="header"
            currentUrl={props.values?.coverUrl}
            error={props.errors?.header}
          />
        </div>
      </FieldSection>

      <FieldSection legend="Identity">
        <UsernameField
          host={props.host}
          readOnly={props.readOnly?.username}
          value={props.values?.username}
          error={props.errors?.username}
        />
        <TextField
          id="account-name"
          name="name"
          label="Display name"
          placeholder="John Doe"
          required={true}
          value={props.values?.name}
          hint="Your display name will be shown on your profile."
          error={props.errors?.name}
        />
        <TextareaField
          id="account-bio"
          name="bio"
          label="Bio"
          placeholder="A software engineer in Seoul, and a father of two kids."
          value={props.values?.bio}
          hint="A short description of yourself.  Markdown is supported."
          error={props.errors?.bio}
        />
      </FieldSection>

      <FieldSection
        legend="Custom fields"
        description="Up to 10 label–value pairs shown on your profile. Leave empty rows blank to omit."
      >
        <div>
          <div class="mb-1 grid grid-cols-2 gap-3">
            <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Label
            </span>
            <span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Value
            </span>
          </div>
          <div id="custom-fields-rows">
            {Array.from({ length: 10 }).map((_, i) => (
              <div class="mt-2 grid grid-cols-2 gap-3">
                <input
                  type="text"
                  name={`fields[${i}][name]`}
                  value={existingFields[i]?.name ?? ""}
                  aria-label={`Field ${i + 1} label`}
                  maxlength={255}
                  class={`${fieldBase} ${fieldValid}`}
                />
                <input
                  type="text"
                  name={`fields[${i}][value]`}
                  value={existingFields[i]?.value ?? ""}
                  aria-label={`Field ${i + 1} value`}
                  maxlength={255}
                  class={`${fieldBase} ${fieldValid}`}
                />
              </div>
            ))}
          </div>
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){
var initial=${initialVisible};
var c=document.getElementById('custom-fields-rows');
var rows=c.querySelectorAll(':scope>div');
for(var i=initial;i<rows.length;i++){rows[i].classList.add('hidden');}
function reveal(){
  var last=0;
  for(var i=0;i<rows.length;i++){if(!rows[i].classList.contains('hidden'))last=i;}
  var inputs=rows[last].querySelectorAll('input');
  var hasContent=false;
  for(var j=0;j<inputs.length;j++){if(inputs[j].value.trim()!==''){hasContent=true;break;}}
  if(hasContent&&last+1<rows.length){rows[last+1].classList.remove('hidden');}
}
for(var i=0;i<rows.length;i++){
  (function(row){
    var inp=row.querySelectorAll('input');
    for(var j=0;j<inp.length;j++){inp[j].addEventListener('input',reveal);}
  })(rows[i]);
}
})();`,
            }}
          />
        </div>
      </FieldSection>

      <FieldSection legend="Privacy">
        <CheckboxField
          name="protected"
          checked={props.values?.protected}
          label="Protect this account"
          hint="Only approved followers can see your posts."
        />
        <CheckboxField
          name="discoverable"
          checked={props.values?.discoverable}
          label="Discoverable"
          hint="Allow this account to be discovered in the public directory."
        />
        <CheckboxField
          name="expandSpoilers"
          checked={props.values?.expandSpoilers}
          label="Expand content warnings by default"
          hint="Some clients, like Phanpy, use this server preference."
        />
      </FieldSection>

      <FieldSection legend="Preferences">
        <div class="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="account-language"
            name="language"
            label="Default language"
          >
            {iso6391
              .getAllCodes()
              .map((code) => [code, iso6391.getNativeName(code)])
              .sort(([_, nameA], [__, nameB]) => nameA.localeCompare(nameB))
              .map(([code, nativeName]) => (
                <option value={code} selected={props.values?.language === code}>
                  {nativeName} ({iso6391.getName(code)})
                </option>
              ))}
          </SelectField>
          <SelectField
            id="account-visibility"
            name="visibility"
            label="Default visibility"
          >
            <option
              value="public"
              selected={props.values?.visibility === "public"}
            >
              Public
            </option>
            <option
              value="unlisted"
              selected={props.values?.visibility === "unlisted"}
            >
              Unlisted
            </option>
            <option
              value="private"
              selected={props.values?.visibility === "private"}
            >
              Followers only
            </option>
            <option
              value="direct"
              selected={props.values?.visibility === "direct"}
            >
              Direct message
            </option>
          </SelectField>
        </div>
        <ThemeColorField selected={props.values?.themeColor} />
      </FieldSection>

      <FieldSection legend="Updates">
        <CheckboxField
          name="news"
          checked={props.values?.news}
          label="Receive Hollo news"
          hint={`Follow the official Hollo account (${props.officialAccount}) to receive news and updates.`}
        />
      </FieldSection>

      <div class="mt-6 flex justify-end border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <SubmitButton>{props.submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

interface UsernameFieldProps {
  host: string;
  readOnly?: boolean;
  value?: string;
  error?: string;
}

function UsernameField({ host, readOnly, value, error }: UsernameFieldProps) {
  const invalid = error != null;
  const wrapperBase =
    "flex w-full overflow-hidden rounded-md border bg-white shadow-sm transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 dark:bg-neutral-950 dark:focus-within:ring-brand-900";
  const wrapperBorder = invalid
    ? "border-red-500 dark:border-red-500"
    : "border-neutral-300 dark:border-neutral-700";
  const chipClass =
    "flex items-center bg-neutral-50 px-3 text-sm text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400";
  return (
    <Field
      id="account-username"
      label="Username"
      labelExtra={readOnly ? "(cannot change)" : undefined}
      hint="Your username will be a part of your fediverse handle."
      error={error}
    >
      <div class={`${wrapperBase} ${wrapperBorder}`}>
        <span class={chipClass} aria-hidden="true">
          @
        </span>
        <input
          id="account-username"
          type="text"
          name="username"
          required={true}
          placeholder="john"
          readOnly={readOnly}
          value={value}
          aria-invalid={invalid ? "true" : undefined}
          pattern="^[\p{L}\p{N}._\-]+$"
          class="border-0 flex-1 bg-transparent px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-neutral-50 read-only:text-neutral-500 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:read-only:bg-neutral-900 dark:read-only:text-neutral-400"
        />
        <span class={chipClass} aria-hidden="true">
          @{host}
        </span>
      </div>
    </Field>
  );
}

interface ImageUploadFieldProps {
  id: string;
  name: string;
  label: string;
  variant: "avatar" | "header";
  currentUrl?: string | null;
  error?: string;
}

function ImageUploadField({
  id,
  name,
  label,
  variant,
  currentUrl,
  error,
}: ImageUploadFieldProps) {
  const hasImage = currentUrl != null && currentUrl !== "";
  const isAvatar = variant === "avatar";
  const containerClass = isAvatar
    ? "size-24 rounded-full"
    : "aspect-[3/1] w-full rounded-xl";
  const dropZoneBase =
    "group relative flex cursor-pointer items-center justify-center overflow-hidden border-2 border-dashed transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100 dark:focus-within:ring-brand-900";
  const dropZoneColors =
    "border-neutral-300 bg-neutral-50 hover:border-brand-400 hover:bg-brand-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-brand-600 dark:hover:bg-neutral-800";
  return (
    <div>
      <span class="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
        {label}
      </span>
      <div class="mt-1">
        <label
          for={id}
          id={`${id}-zone`}
          class={`${containerClass} ${dropZoneBase} ${dropZoneColors}`}
        >
          <img
            id={`${id}-preview`}
            src={hasImage ? (currentUrl as string) : ""}
            alt={hasImage ? `Current ${label.toLowerCase()}` : ""}
            class={`size-full object-cover${hasImage ? "" : " hidden"}`}
          />
          <div
            id={`${id}-overlay`}
            class={`absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/50 text-white transition-opacity${hasImage ? " opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" : " opacity-0"}`}
          >
            <span class="i-lucide-camera text-2xl" aria-hidden="true" />
            <span class="text-xs font-semibold">Change</span>
          </div>
          <div
            id={`${id}-placeholder`}
            class={`flex flex-col items-center justify-center gap-2 p-4 text-center text-neutral-500 dark:text-neutral-400${hasImage ? " hidden" : ""}`}
          >
            <span class="i-lucide-image-up text-2xl" aria-hidden="true" />
            <span class="text-xs leading-tight">
              Drop image here
              <br />
              or click to browse
            </span>
            <span class="text-xs text-neutral-400 dark:text-neutral-500">
              JPEG · PNG · GIF
            </span>
          </div>
          <input
            id={id}
            type="file"
            name={name}
            accept="image/jpeg,image/png,image/gif"
            aria-label={label}
            class="sr-only"
          />
        </label>
      </div>
      {error ? (
        <p class="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
      ) : (
        <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {isAvatar
            ? "Recommended: square image, at least 400 × 400 px."
            : "Recommended: 1500 × 500 px or wider."}
        </p>
      )}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){
var input=document.getElementById(${JSON.stringify(id)});
var zone=document.getElementById(${JSON.stringify(`${id}-zone`)});
var preview=document.getElementById(${JSON.stringify(`${id}-preview`)});
var placeholder=document.getElementById(${JSON.stringify(`${id}-placeholder`)});
var overlay=document.getElementById(${JSON.stringify(`${id}-overlay`)});
var dragOn=['border-brand-500','bg-brand-50','dark:border-brand-500','dark:bg-brand-950'];
var dragOff=['border-neutral-300','bg-neutral-50','dark:border-neutral-700','dark:bg-neutral-900'];
function showPreview(file){
  var url=URL.createObjectURL(file);
  preview.src=url;
  preview.classList.remove('hidden');
  preview.alt='New ${label.toLowerCase()}';
  if(placeholder)placeholder.classList.add('hidden');
  if(overlay&&overlay.classList.contains('opacity-0')&&!overlay.classList.contains('group-hover:opacity-100')){
    overlay.style.opacity='';
  }
}
input.addEventListener('change',function(){
  if(this.files&&this.files[0])showPreview(this.files[0]);
});
zone.addEventListener('dragover',function(e){
  e.preventDefault();
  dragOn.forEach(function(c){zone.classList.add(c);});
  dragOff.forEach(function(c){zone.classList.remove(c);});
});
zone.addEventListener('dragleave',function(e){
  if(!zone.contains(e.relatedTarget)){
    dragOff.forEach(function(c){zone.classList.add(c);});
    dragOn.forEach(function(c){zone.classList.remove(c);});
  }
});
zone.addEventListener('drop',function(e){
  e.preventDefault();
  dragOff.forEach(function(c){zone.classList.add(c);});
  dragOn.forEach(function(c){zone.classList.remove(c);});
  var file=e.dataTransfer&&e.dataTransfer.files[0];
  if(file){
    var assigned=false;
    try{var dt=new DataTransfer();dt.items.add(file);input.files=dt.files;assigned=true;}catch(ex){}
    if(assigned)showPreview(file);
  }
});
})();`,
        }}
      />
    </div>
  );
}

interface ThemeColorFieldProps {
  selected?: ThemeColor;
}

function ThemeColorField({ selected }: ThemeColorFieldProps) {
  const active = selected ?? "azure";
  return (
    <Field
      id={`account-theme-color-${active}`}
      label="Theme color"
      hint="Tints this account's profile and post pages."
    >
      <div class="grid grid-cols-8 gap-2 sm:grid-cols-10">
        {THEME_COLORS.map((color) => {
          const swatch = `rgb(${themeColors[color][500]})`;
          const inputId = `account-theme-color-${color}`;
          return (
            <label
              for={inputId}
              title={capitalize(color)}
              class="relative aspect-square cursor-pointer rounded-md ring-2 ring-transparent ring-offset-2 ring-offset-white transition-shadow hover:ring-neutral-300 has-[:checked]:ring-neutral-900 dark:ring-offset-neutral-900 dark:hover:ring-neutral-700 dark:has-[:checked]:ring-neutral-100"
              style={`background-color: ${swatch};`}
            >
              <input
                id={inputId}
                type="radio"
                name="themeColor"
                value={color}
                checked={active === color}
                class="peer sr-only"
              />
              <span class="sr-only">{capitalize(color)}</span>
              <span
                class="pointer-events-none absolute inset-0 flex items-center justify-center text-white opacity-0 drop-shadow peer-checked:opacity-100"
                aria-hidden="true"
              >
                <span class="i-lucide-check text-sm" />
              </span>
            </label>
          );
        })}
      </div>
    </Field>
  );
}
