import { NextFunction, Request, Response } from 'express';
import compare from 'string-comparison';
import fs from 'fs';
import multer, { memoryStorage } from 'multer';
import path from 'path';

const FILE_ERROR = 'Файлы обязательны должны быть текстовыми';
const TEXT_ERROR = 'Не введено текстовое поле';
const RESPONSE_FILE_NAME = 'Ответ на запрос.txt';
// Лимиты защищают сервер: алгоритм Левенштейна занимает O(n·m) времени и памяти и выполняется в event loop,
// поэтому на больших файлах один запрос надолго блокирует все остальные.
const MAX_FILE_SIZE = 100 * 1024; // 100 КБ на файл
const MAX_TEXT_LENGTH = 5000; // символов в каждом файле
const LENGTH_ERROR = `Каждый файл должен содержать не больше ${MAX_TEXT_LENGTH} символов`;

const HBS_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Расстояние Левинштейна</title>
</head>
<body>
    <main class="main">
          {{#if showErrors}}
        <div class="errors">
            {{#each errors}}
                <div>{{this}}</div>
            {{/each}}
        </div>
    {{/if}}
    <form action="/" class="form" method="post" enctype="multipart/form-data">
        <label >Введите текст: <input type="text" name="text" id="name"></label>        
        <input type="file" name="file1" id="file1">
        <input type="file" name="file2" id="file2">
        <input type="submit" value="Отправить" class="submit-btn">
    </form>
    </main>
</body>
<style>
    body {
        margin: 0;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 30px;
        background-color: #e9e4e4;
    }
    .main {
        width: 60%;
        height: 100%;
    }
    .form {
        display: flex;
        flex-direction: column;
        gap: 20px
    }
    .errors {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 30px;
        background-color: #ec6969;
        border-radius: 16px;
        padding: 20px;
        color:  #e9e4e4;
        font-size: 20px;
    }
    .submit-btn {
        margin: auto;
        min-width: 150px;
    }
</style>
</html>`;

const upload = multer({
	storage: memoryStorage(),
	limits: {
		// fieldSize ограничивал только текстовые поля формы, а не файлы
		fileSize: MAX_FILE_SIZE,
		files: 2,
		fieldSize: 10 * 1024
	},
	fileFilter(req, file, callback) {
		if (file.mimetype == 'text/plain') {
			callback(null, true);
		} else {
			callback(null, false);
		}
	}
});

const filesUpload = upload.fields([
	{ name: 'file1', maxCount: 1 },
	{ name: 'file2', maxCount: 1 }
]);

function validateLength(textFile1: string, textFile2: string): string[] {
	return textFile1.length > MAX_TEXT_LENGTH || textFile2.length > MAX_TEXT_LENGTH
		? [LENGTH_ERROR]
		: [];
}

function getResponseData(text: string, metric: number) {
	return `Для запроса ${text} сходство (расстояние Левинштейна) равно ${metric}`;
}

function validateBody(text: string, file1: any, file2: any): string[] {
	const errors: string[] = [];

	if (!text) {
		errors.push(TEXT_ERROR);
	}
	if (!file1 || !file2) {
		errors.push(FILE_ERROR);
	}
	return errors;
}

function handle(req: Request, res: Response, next: NextFunction) {
	try {
		const acceptedTypes = req.headers.accept?.split(',');
		const contentType = req.headers['content-type'];
		const method = req.method;

		if (method == 'GET' && acceptedTypes?.includes('text/html')) {
			res.render('index', {
				showErrors: false
			});
		} else if (method == 'POST' && contentType?.includes('multipart/form-data')) {
			filesUpload(req, res, function (err) {
				let errors: string[] = [];
				if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
					errors.push(`Размер каждого файла не должен превышать ${MAX_FILE_SIZE / 1024} КБ`);
				} else if (err) {
					errors.push('Ошибка при загрузке файлов');
				}
				const { text } = req.body ?? {};

				// при ошибке загрузки multer может не заполнить req.files, а исключение внутри
				// этого колбэка Express не перехватывает — процесс бы упал
				const files: any = req.files ?? {};
				const { file1, file2 } = files;

				errors = [...errors, ...validateBody(text, file1, file2)];

				if (errors.length) {
					return res.render('index', {
						showErrors: true,
						errors
					});
				}
				const textFile1 = file1[0].buffer.toString();
				const textFile2 = file2[0].buffer.toString();

				const lengthErrors = validateLength(textFile1, textFile2);
				if (lengthErrors.length) {
					return res.status(413).render('index', {
						showErrors: true,
						errors: lengthErrors
					});
				}

				const distance = compare.levenshtein.distance(textFile1, textFile2);

				// Ответ отдаётся из памяти: раньше он писался в один общий файл на диске,
				// и при параллельных запросах пользователь мог скачать чужой результат.
				return res
					.attachment(RESPONSE_FILE_NAME)
					.type('text/plain; charset=utf-8')
					.send(getResponseData(text, distance));
			});
		} else if (method == 'POST') {
			const { text, file1, file2 } = req.body;
			const errors = validateBody(text, file1, file2);
			if (errors.length) {
				return res.json({
					errors
				});
			}
			if (typeof file1 !== 'string' || typeof file2 !== 'string') {
				return res.status(400).json({ errors: [FILE_ERROR] });
			}
			const textFile1 = Buffer.from(file1, 'base64').toString();
			const textFile2 = Buffer.from(file2, 'base64').toString();

			const lengthErrors = validateLength(textFile1, textFile2);
			if (lengthErrors.length) {
				return res.status(413).json({ errors: lengthErrors });
			}

			const distance = compare.levenshtein.distance(textFile1, textFile2);

			return res.json({
				data: getResponseData(text, distance)
			});
		} else {
			return res.json({
				help: 'Отправьте запрос с данными. Файлы кодируйте в Base64.',
				example: {
					text: 'Текстовая строка',
					file1: '0KHQvtC00LXRgNC20LjQvNC+0LUg0L/QtdGA0LLQvtCz0L4g0YTQsNC50LvQsC4=',
					file2: '0KHQvtC00LXRgNC20LjQvNC+0LUg0LLRgtC+0YDQvtCz0L4g0YTQsNC50LvQsC4='
				}
			});
		}
	} catch (err: any) {
		throw err;
	}
}

function handleError(err: Error, req: Request, res: Response, Next: NextFunction) {
	const message = err.message;

	return res.status(500).json({ message });
}

function initViews() {
	const viewsPath = path.join(process.cwd(), 'views');
	const existDir = fs.existsSync(viewsPath);
	if (!existDir) {
		fs.mkdirSync(viewsPath);
	}
	const filePath = path.join(viewsPath, 'index.hbs');
	const existFile = fs.existsSync(filePath);
	if (!existFile) {
		fs.writeFileSync(filePath, HBS_CONTENT);
	}
}

export { handle, handleError, initViews };
